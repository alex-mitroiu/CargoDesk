import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor, fireEvent } from "@testing-library/react";
import { addDays, todayIso } from "../tokens";

// Tests for the Space Configurations table. The page had no UI tests, and it is the delicate one of the
// list pages: `allocations` is the App-level array that the bell, Landing, Dashboard and Archive also read,
// and the server-computed confirmed/pending/rejected/remaining figures are authoritative — the table must
// show them as they are, never recompute them. The first two groups below were written BEFORE the table was
// moved onto the shared DataTable and pin what a row shows (the figures, the status wording, the alert
// stripe, the MQC flag, the cog menu) so that move could not quietly change any of it; the rest cover what
// the move added (the Origin/Destination Trade split, header filters, search, the Confirmed sort) and the
// form's matching Trade panel.

const PORTS = vi.hoisted(() => ({
  names: { NLRTM: "Rotterdam", USLAX: "Los Angeles", CNSHA: "Shanghai", AEJEA: "Jebel Ali", CNNGB: "Ningbo", GBFXT: "Felixstowe", USNYC: "New York" },
  // a port's primary trade lane — the same rule GET /api/port-locations/:code/lanes applies
  lanes: { NLRTM: "EU-N", USLAX: "NAM", CNSHA: "FE", AEJEA: "ME", CNNGB: "FE", GBFXT: "EU-N", USNYC: "NAM" },
  laneNames: { "EU-N": "Europe North", NAM: "North America", FE: "Far East", ME: "Middle East" },
}));
vi.mock("../AuthContext", () => ({ useAuth: () => ({ canManageConfigs: true }) }));
vi.mock("../api", () => ({
  api: {
    tradeLanes: { list: vi.fn(() => Promise.resolve(Object.entries(PORTS.laneNames).map(([code, name]) => ({ code, name })))) },
    linkedPorts: { list: vi.fn(() => Promise.resolve([])) },
    contracts: { get: vi.fn(() => Promise.resolve(null)) },
    portLinks: vi.fn(() => Promise.resolve([])),
    portLanes: vi.fn(code => Promise.resolve(PORTS.lanes[code]
      ? { lanes: [{ code: PORTS.lanes[code], name: PORTS.laneNames[PORTS.lanes[code]] }], primary: PORTS.lanes[code] }
      : { lanes: [], primary: null })),
    // The real object is `api.ports` (src/api.js); a call to any other name must fail here as it does in the app.
    ports: {
      get: vi.fn(code => (PORTS.names[code] ? Promise.resolve({ unlocode: code, name: PORTS.names[code] }) : Promise.reject(new Error("Not found")))),
      search: vi.fn(() => Promise.resolve([])),
    },
    carriers: { list: vi.fn(() => Promise.resolve([])) },
    allocations: { conflicts: vi.fn(() => Promise.resolve({ exact: [], linked: [] })) },
  },
}));

import SpaceConfigurationsPage from "./SpaceConfigurationsPage";
import { api } from "../api";

const today = todayIso();
const base = {
  effectiveDate: addDays(today, -10), endDate: addDays(today, 20), alertThreshold: 80, minimumTEU: null,
  confirmedTEU: 0, pendingTEU: 0, rejectedTEU: 0, notes: "", originLane: "", destLane: "", contractId: "",
};
const ALLOCATIONS = [
  // Under the alert threshold, with pending TEU and an unmet minimum commitment (MQC).
  { ...base, id: "ALC-OK", carrierCode: "HLCU", pol: "NLRTM", pod: "USLAX", contractNumber: "HLCU-EUN_USWC_0001",
    allocatedTEU: 50, confirmedTEU: 13, pendingTEU: 5, remainingTEU: 37, minimumTEU: 40, originLane: "EU-N", destLane: "NAM" },
  // At the alert threshold (85% of 100, threshold 80).
  { ...base, id: "ALC-AT", carrierCode: "EGLV", pol: "CNSHA", pod: "USLAX", contractNumber: "EGLV-AT-001",
    allocatedTEU: 100, confirmedTEU: 85, remainingTEU: 15 },
  // Fully consumed, with rejected TEU.
  { ...base, id: "ALC-OVER", carrierCode: "MAEU", pol: "CNSHA", pod: "AEJEA", contractNumber: "MAEU-OVER-001",
    allocatedTEU: 100, confirmedTEU: 100, rejectedTEU: 5, remainingTEU: 0 },
  // Starts in the future.
  { ...base, id: "ALC-FUT", carrierCode: "ONEY", pol: "CNNGB", pod: "NLRTM", contractNumber: "ONEY-FUT-001",
    allocatedTEU: 160, remainingTEU: 160, effectiveDate: addDays(today, 5), endDate: addDays(today, 40) },
  // No contract selected.
  { ...base, id: "ALC-NOC", carrierCode: "HLCU", pol: "GBFXT", pod: "USNYC", contractNumber: "",
    allocatedTEU: 180, remainingTEU: 180 },
  // Already ended — belongs on the Archive page, never in this table.
  { ...base, id: "ALC-OLD", carrierCode: "CMDU", pol: "NLRTM", pod: "USNYC", contractNumber: "CMDU-OLD-001",
    allocatedTEU: 21, remainingTEU: 21, effectiveDate: addDays(today, -60), endDate: addDays(today, -1) },
];
const CARRIERS = [
  { code: "HLCU", name: "Hapag Lloyd Container Line" }, { code: "EGLV", name: "Evergreen Line" },
  { code: "MAEU", name: "Maersk Line" }, { code: "ONEY", name: "Ocean Network Express (ONE Line)" },
  { code: "CMDU", name: "CMA CGM" },
];
const PAGE_PROPS = { carriers: CARRIERS, shipments: [], containers: [], onAddAlloc() {}, onEditAlloc() {}, onDeleteAlloc() {}, navigate() {} };

const renderPage = (props = {}) => render(<SpaceConfigurationsPage allocations={ALLOCATIONS} {...PAGE_PROPS} {...props} />);

// A table row is whichever ancestor of a known cell holds the whole grid of cells.
const rowOf = node => { let el = node; while (el && el.children.length < 8) el = el.parentElement; return el; };
const rowByContract = async number => rowOf(await screen.findByText(number));

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

describe("Space Configurations — which rows appear", () => {
  it("lists every active or upcoming configuration and leaves out ended ones", async () => {
    renderPage();
    for (const n of ["HLCU-EUN_USWC_0001", "EGLV-AT-001", "MAEU-OVER-001", "ONEY-FUT-001"]) {
      expect(await screen.findByText(n)).toBeInTheDocument();
    }
    expect(screen.queryByText("CMDU-OLD-001")).toBeNull();
  });

  it("counts them in the page subtitle", async () => {
    renderPage();
    expect(await screen.findByText(/5 active configurations/)).toBeInTheDocument();
  });

  it("says so when there is nothing to show", async () => {
    renderPage({ allocations: [] });
    expect(await screen.findByText(/No active configurations/)).toBeInTheDocument();
  });
});

describe("Space Configurations — what a row shows", () => {
  it("shows the carrier, its name, the route and the awarded TEU", async () => {
    renderPage();
    const row = await rowByContract("HLCU-EUN_USWC_0001");
    expect(row).toHaveTextContent("HLCU");
    expect(row).toHaveTextContent("Hapag Lloyd Container Line");
    expect(row).toHaveTextContent("NLRTM");
    expect(row).toHaveTextContent("USLAX");
    expect(row).toHaveTextContent("50 TEU");
  });

  it("shows the server's own confirmed / pending / rejected figures and the consumption percentage, unaltered", async () => {
    renderPage();
    const ok = await rowByContract("HLCU-EUN_USWC_0001");
    expect(ok).toHaveTextContent("13 TEU");            // confirmed
    expect(ok).toHaveTextContent("+5 pending");
    expect(ok).toHaveTextContent("26%");                // 13 / 50
    expect(ok).toHaveTextContent("/ 80%");              // the alert threshold beside it

    const over = await rowByContract("MAEU-OVER-001");
    expect(over).toHaveTextContent("+5 rejected");
    expect(over).toHaveTextContent("100%");
  });

  it("flags a configuration below its minimum quantity commitment", async () => {
    renderPage();
    expect(await rowByContract("HLCU-EUN_USWC_0001")).toHaveTextContent("MQC 13/40");
    expect(await rowByContract("EGLV-AT-001")).not.toHaveTextContent("MQC");
  });

  it("shows the effective period, and '— missing' when no contract is selected", async () => {
    renderPage();
    const ok = await rowByContract("HLCU-EUN_USWC_0001");
    expect(ok).toHaveTextContent(base.effectiveDate);
    expect(ok).toHaveTextContent(base.endDate);
    const noContract = rowOf(await screen.findByText(/— missing/));
    expect(noContract).toHaveTextContent("GBFXT");
  });
});

describe("Space Configurations — status wording and the alert stripe", () => {
  it("says Active, At Limit, Over Limit or Future", async () => {
    renderPage();
    expect(await rowByContract("HLCU-EUN_USWC_0001")).toHaveTextContent("Active");
    expect(await rowByContract("EGLV-AT-001")).toHaveTextContent("At Limit");
    expect(await rowByContract("MAEU-OVER-001")).toHaveTextContent("Over Limit");
    expect(await rowByContract("ONEY-FUT-001")).toHaveTextContent("Future");
  });

  it("marks rows at or past their threshold with a coloured left stripe (warning at the limit, danger over it)", async () => {
    renderPage();
    const stripe = row => row.style.borderLeft || getComputedStyle(row).borderLeft;
    expect(stripe(await rowByContract("HLCU-EUN_USWC_0001"))).toMatch(/transparent/);
    expect(stripe(await rowByContract("EGLV-AT-001"))).not.toMatch(/transparent/);
    expect(stripe(await rowByContract("MAEU-OVER-001"))).not.toMatch(/transparent/);
    // The two alerting rows get different colours: over the limit is stronger than at it.
    expect(stripe(await rowByContract("EGLV-AT-001"))).not.toEqual(stripe(await rowByContract("MAEU-OVER-001")));
  });
});

describe("Space Configurations — row actions", () => {
  it("offers Edit, Linked Shipments, History and Delete to someone who can manage configurations", async () => {
    renderPage();
    const row = await rowByContract("HLCU-EUN_USWC_0001");
    within(row).getByRole("button").click();
    for (const label of ["Edit", "Linked Shipments", "History", "Delete"]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  it("opens the Add Configuration form from the header button", async () => {
    renderPage();
    (await screen.findByText(/Add Configuration/)).click();
    await waitFor(() => expect(screen.getByText("Add Space Configuration")).toBeInTheDocument());
  });
});

// ── The shared table: trade split, header filters, the Confirmed sort, search ─────────────────────────

const rowIds = () => screen.getAllByTestId(/^space-configs-row-/).map(r => r.getAttribute("data-testid").replace("space-configs-row-", ""));
const colBtn = key => within(screen.getByTestId(`space-configs-col-${key}`)).getByRole("button");
const tick = name => fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(`^${name}`) }));
const sortBy = name => { fireEvent.click(colBtn("confirmed")); fireEvent.click(screen.getByRole("menuitemradio", { name })); };
const ready = () => screen.findByTestId("space-configs-row-ALC-OK");

describe("Space Configurations — Origin and Destination Trade", () => {
  it("shows Trade as one heading over separate Origin and Destination columns", async () => {
    renderPage();
    await ready();
    expect(screen.getByTestId("space-configs-group-Trade")).toHaveTextContent("Trade");
    expect(colBtn("origin")).toHaveTextContent("Origin");
    expect(colBtn("dest")).toHaveTextContent("Destination");
  });

  it("shows a stored lane as a solid pill with the lane's full name", async () => {
    renderPage();
    const row = await ready();
    await waitFor(() => expect(row).toHaveTextContent("Europe North"));
    expect(row).toHaveTextContent("EU-N");
    expect(row).toHaveTextContent("North America");
    const pills = within(row).getAllByTestId("lane-pill");
    expect(pills.map(p => p.getAttribute("data-derived"))).toEqual(["false", "false"]);
  });

  it("derives a missing lane from the port's primary lane and marks it as derived", async () => {
    renderPage();
    const row = await screen.findByTestId("space-configs-row-ALC-AT");            // CNSHA → USLAX, nothing stored
    await waitFor(() => expect(within(row).getAllByTestId("lane-pill")).toHaveLength(2));
    const [origin, dest] = within(row).getAllByTestId("lane-pill");
    expect([origin.textContent, dest.textContent]).toEqual(["FE", "NAM"]);
    expect([origin.getAttribute("data-derived"), dest.getAttribute("data-derived")]).toEqual(["true", "true"]);
    expect(row).toHaveTextContent("Far East");
  });

  it("looks a lane up only for a side that stores none, and each port only once", async () => {
    renderPage();
    await ready();
    // The four unstored rows need CNSHA×2, USLAX, AEJEA, CNNGB, NLRTM (as ALC-FUT's destination), GBFXT and USNYC;
    // CNSHA and USLAX are shared between rows and asked once each. ALC-OK stores both its lanes and adds nothing.
    const asked = api.portLanes.mock.calls.map(c => c[0]).sort();
    expect(asked).toEqual(["AEJEA", "CNNGB", "CNSHA", "GBFXT", "NLRTM", "USLAX", "USNYC"]);
  });

  it("asks for nothing when every row already stores both lanes", async () => {
    renderPage({ allocations: [ALLOCATIONS[0]] });
    await ready();
    expect(api.portLanes).not.toHaveBeenCalled();
  });

  it("still shows every row, without names or derived lanes, when the port lookups fail", async () => {
    const realGet = api.ports.get.getMockImplementation();
    const realLanes = api.portLanes.getMockImplementation();
    api.ports.get.mockImplementation(() => { throw new Error("service down"); });          // throws before returning a promise
    api.portLanes.mockImplementation(() => Promise.reject(new Error("service down")));
    try {
      renderPage();
      const row = await ready();
      expect(rowIds()).toHaveLength(5);
      expect(within(row).getAllByTestId("lane-pill")).toHaveLength(2);           // ALC-OK's stored lanes need no lookup
      const derived = await screen.findByTestId("space-configs-row-ALC-AT");
      expect(within(derived).queryAllByTestId("lane-pill")).toHaveLength(0);     // nothing to derive from
      expect(derived).toHaveTextContent("CNSHA");
    } finally {
      api.ports.get.mockImplementation(realGet);
      api.portLanes.mockImplementation(realLanes);
    }
  });

  it("leaves a side empty when its port has no lane", async () => {
    renderPage({ allocations: [{ ...ALLOCATIONS[4], id: "ALC-ZZ", pol: "ZZAUD1", pod: "ZZAUD2" }] });
    const row = await screen.findByTestId("space-configs-row-ALC-ZZ");
    await waitFor(() => expect(row).toHaveTextContent("ZZAUD1"));
    expect(within(row).queryAllByTestId("lane-pill")).toHaveLength(0);
  });
});

describe("Space Configurations — header filters and search", () => {
  it("filters by carrier from the header checklist, with the carrier's name beside each code", async () => {
    renderPage();
    await ready();
    fireEvent.click(colBtn("carrier"));
    // the checklist row for a value reads "<code><name>" — the name sits beside the code
    expect(await screen.findByRole("checkbox", { name: "EGLVEvergreen Line" })).toBeInTheDocument();
    tick("HLCU");                                          // untick HLCU → the other carriers remain
    await waitFor(() => expect(rowIds()).toEqual(["ALC-AT", "ALC-OVER", "ALC-FUT"]));
  });

  it("lists the routes with their port names, and filters by route", async () => {
    renderPage();
    await ready();
    fireEvent.click(colBtn("route"));
    expect(await screen.findByText("Rotterdam › Los Angeles")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));               // popover: show nothing
    tick("NLRTM › USLAX");
    await waitFor(() => expect(rowIds()).toEqual(["ALC-OK"]));
  });

  it("filters on the derived lane too: a row shows up under FE whether the lane is stored or looked up", async () => {
    renderPage();
    await ready();
    fireEvent.click(colBtn("origin"));
    await screen.findByRole("checkbox", { name: /^FE/ });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    tick("FE");
    await waitFor(() => expect(rowIds()).toEqual(["ALC-AT", "ALC-OVER", "ALC-FUT"]));   // CNSHA ×2 and CNNGB
  });

  it("searches by carrier, port name or contract", async () => {
    renderPage();
    await ready();
    const box = screen.getByPlaceholderText(/Search carrier/);
    fireEvent.change(box, { target: { value: "shanghai" } });
    await waitFor(() => expect(rowIds()).toEqual(["ALC-AT", "ALC-OVER"]));            // port NAME, not just the code
    fireEvent.change(box, { target: { value: "ONEY-FUT" } });
    await waitFor(() => expect(rowIds()).toEqual(["ALC-FUT"]));
  });

  it("says when nothing matches, and Clear brings everything back", async () => {
    renderPage();
    await ready();
    fireEvent.change(screen.getByPlaceholderText(/Search carrier/), { target: { value: "zzzz nothing" } });
    expect(await screen.findByText("No configurations match your filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("space-configs-clear"));
    await waitFor(() => expect(rowIds()).toHaveLength(5));
  });

  it("keeps the subtitle's count of ALL active configurations while filtered", async () => {
    renderPage();
    await ready();
    fireEvent.change(screen.getByPlaceholderText(/Search carrier/), { target: { value: "ONEY" } });
    await waitFor(() => expect(rowIds()).toEqual(["ALC-FUT"]));
    expect(screen.getByText(/5 active configurations/)).toBeInTheDocument();
  });
});

describe("Space Configurations — sorting from the Confirmed header", () => {
  it("has a sort control on Confirmed, none on TEU or Effective Period", async () => {
    renderPage();
    await ready();
    expect(within(screen.getByTestId("space-configs-col-teu")).queryByRole("button")).toBeNull();
    expect(within(screen.getByTestId("space-configs-col-period")).queryByRole("button")).toBeNull();
    expect(colBtn("confirmed")).toHaveTextContent("Confirmed");
  });

  it("sorts by awarded TEU, high to low and low to high", async () => {
    renderPage();
    await ready();
    sortBy("Awarded TEU: High to low");                    // 180, 160, 100, 100, 50
    await waitFor(() => expect(rowIds()).toEqual(["ALC-NOC", "ALC-FUT", "ALC-AT", "ALC-OVER", "ALC-OK"]));
    sortBy("Awarded TEU: Low to high");
    await waitFor(() => expect(rowIds()).toEqual(["ALC-OK", "ALC-AT", "ALC-OVER", "ALC-FUT", "ALC-NOC"]));
  });

  it("sorts by consumption (confirmed ÷ awarded), high to low and low to high", async () => {
    renderPage();
    await ready();
    sortBy("Consumption (confirmed ÷ awarded): High to low");       // OVER 100%, AT 85%, OK 26%, then the two at 0%
    await waitFor(() => expect(rowIds()).toEqual(["ALC-OVER", "ALC-AT", "ALC-OK", "ALC-FUT", "ALC-NOC"]));
    expect(screen.getByTestId("column-sort-marker")).toHaveTextContent("%");
    sortBy("Consumption (confirmed ÷ awarded): Low to high");
    await waitFor(() => expect(rowIds()).toEqual(["ALC-FUT", "ALC-NOC", "ALC-OK", "ALC-AT", "ALC-OVER"]));
  });

  it("Clear returns to the delivered order and unlights the sort", async () => {
    renderPage();
    await ready();
    sortBy("Awarded TEU: High to low");
    await waitFor(() => expect(rowIds()[0]).toBe("ALC-NOC"));
    fireEvent.click(screen.getByTestId("space-configs-clear"));
    await waitFor(() => expect(rowIds()).toEqual(["ALC-OK", "ALC-AT", "ALC-OVER", "ALC-FUT", "ALC-NOC"]));
    expect(screen.queryByTestId("column-sort-marker")).toBeNull();
  });
});

describe("Space Configurations — follows the App's allocations", () => {
  it("picks up a configuration added, and one removed, without reloading", async () => {
    const { rerender } = renderPage();
    await ready();
    const added = { ...ALLOCATIONS[4], id: "ALC-NEW", contractNumber: "NEW-001", carrierCode: "EGLV" };
    rerender(<SpaceConfigurationsPage allocations={[...ALLOCATIONS, added]} {...PAGE_PROPS} />);
    expect(await screen.findByText("NEW-001")).toBeInTheDocument();
    expect(screen.getByText(/6 active configurations/)).toBeInTheDocument();
    rerender(<SpaceConfigurationsPage allocations={ALLOCATIONS.filter(a => a.id !== "ALC-OK")} {...PAGE_PROPS} />);
    await waitFor(() => expect(screen.queryByText("HLCU-EUN_USWC_0001")).toBeNull());
  });
});

describe("Space Configurations — the form's Trade panel", () => {
  const openEdit = async id => {
    const row = await screen.findByTestId(`space-configs-row-${id}`);
    fireEvent.click(within(row).getByRole("button"));
    fireEvent.click(await screen.findByText("Edit"));
  };

  it("says Origin Trade and Destination Trade, each with its lane, its name and the port it came from", async () => {
    renderPage();
    await openEdit("ALC-OK");
    const origin = await screen.findByTestId("trade-origin");
    await waitFor(() => expect(origin).toHaveTextContent("Europe North"));
    expect(origin).toHaveTextContent("Origin Trade");
    expect(origin).toHaveTextContent("EU-N");
    expect(origin).toHaveTextContent("from POL · NLRTM");
    const dest = screen.getByTestId("trade-destination");
    expect(dest).toHaveTextContent("Destination Trade");
    expect(dest).toHaveTextContent("NAM");
    expect(dest).toHaveTextContent("from POD · USLAX");
    expect(screen.queryByText(/Trade Lane Route/)).toBeNull();
  });

  it("Override turns the two cards into Origin Trade / Destination Trade selectors", async () => {
    renderPage();
    await openEdit("ALC-OK");
    await screen.findByTestId("trade-origin");
    fireEvent.click(screen.getByText("Override"));
    expect(screen.getByText("Origin Trade")).toBeInTheDocument();
    expect(screen.getByText("Destination Trade")).toBeInTheDocument();
    expect(screen.queryByText("Origin Lane")).toBeNull();
    expect(screen.queryByText("Destination Lane")).toBeNull();
  });

  it("keeps a lane that was deliberately set to something other than the port's own primary lane", async () => {
    // NLRTM's primary lane is EU-N, but this configuration was saved with FE (an override). Opening it to edit
    // something else must not silently swap that back.
    renderPage({ allocations: [{ ...ALLOCATIONS[0], id: "ALC-FE", originLane: "FE" }] });
    await openEdit("ALC-FE");
    const origin = await screen.findByTestId("trade-origin");
    await waitFor(() => expect(api.portLanes).toHaveBeenCalledWith("NLRTM"));
    await new Promise(r => setTimeout(r, 50));
    expect(within(origin).getByTestId("lane-pill")).toHaveTextContent("FE");
  });
});
