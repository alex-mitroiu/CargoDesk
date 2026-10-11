import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

// RoutingLinesEditor — the contract's Option 1 legs editor (TKT-WW88OU, a coverage gap the
// TKT-SQVGJ2 audit found: the routing-line rules had unit tests, the editor itself none). The rules
// live in src/utils/routingLines.js; these pin what the editor adds on top: what it warns about,
// what it blocks, and which callback each edit reaches.

// Mirror the REAL api.js's shape, every leaf "resolves []" — a wrong method name fails here as it
// would in the app (see feedback in App.test.jsx / ShipmentHeaderBar.test.jsx).
vi.mock("../../api", async () => {
  const actual = await vi.importActual("../../api");
  const mockDeep = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [
    k,
    typeof v === "function" ? vi.fn().mockResolvedValue([])
      : (v && typeof v === "object") ? mockDeep(v)
      : v,
  ]));
  return { ...actual, api: mockDeep(actual.api) };
});

import RoutingLinesEditor from "./RoutingLinesEditor";
import { api } from "../../api";

const leg = (pol, pod, routingIndex, extra = {}) => ({
  pol, pod, routingIndex, polLocType: "Terminal", podLocType: "Terminal", vesselService: "",
  polCarrierHaulage: false, podCarrierHaulage: false, polHaulageLocations: "", podHaulageLocations: "",
  polLinkedAllowed: false, podLinkedAllowed: false, transitDays: 0, ...extra,
});

const handlers = () => ({
  onAddRouting: vi.fn(), onUpdateRouting: vi.fn(), onRemoveRouting: vi.fn(),
  onAddLeg: vi.fn(), onUpdateLeg: vi.fn(), onRemoveLeg: vi.fn(),
});
const renderEditor = (routings, legs, h = handlers()) => {
  render(<RoutingLinesEditor routings={routings} legs={legs} {...h} />);
  return h;
};

beforeEach(() => vi.clearAllMocks());

describe("RoutingLinesEditor — one block per routing line", () => {
  it("shows each line's chain from its legs, its service codes and a kind per leg", () => {
    renderEditor([{ name: "Main" }], [
      leg("NLRTM", "BEANR", 0, { vesselService: "AL5" }),
      leg("BEANR", "USNYC", 0, { vesselService: "AL5" }),
    ]);
    const block = screen.getByTestId("routing-line-0");
    const chain = within(block).getByTestId("routing-line-chain").textContent;
    expect(chain).toContain("NLRTM");
    expect(chain).toContain("USNYC");
    expect(within(block).getAllByText("AL5").length).toBeGreaterThan(0);
    expect(within(block).getByTestId("routing-line-0-leg-0")).toBeInTheDocument();
    expect(within(block).getByTestId("routing-line-0-leg-1")).toBeInTheDocument();
    expect(within(block).getAllByText("Sea").length).toBe(2);
  });

  it("asks for a leg when a line has none", () => {
    renderEditor([{ name: "" }], []);
    expect(screen.getByText("Add a leg to build the route")).toBeInTheDocument();
  });
});

describe("RoutingLinesEditor — what it warns about and blocks", () => {
  it("flags two lines describing the same routing and blocks adding another until it's fixed", () => {
    const h = renderEditor([{ name: "A" }, { name: "B" }], [leg("NLRTM", "USNYC", 0), leg("NLRTM", "USNYC", 1)]);
    expect(screen.getByTestId("routing-line-1-duplicate")).toHaveTextContent("Same routing as line 1");
    const add = screen.getByText("＋ Add routing").closest("button");
    expect(add).toBeDisabled();
    expect(screen.getByText("Fix the duplicate line first")).toBeInTheDocument();
    fireEvent.click(add);
    expect(h.onAddRouting).not.toHaveBeenCalled();
  });

  it("lets two lines that differ only by service code stand", () => {
    renderEditor([{}, {}], [leg("NLRTM", "USNYC", 0, { vesselService: "AL1" }), leg("NLRTM", "USNYC", 1, { vesselService: "AL5" })]);
    expect(screen.queryByTestId("routing-line-1-duplicate")).toBeNull();
    expect(screen.getByText("＋ Add routing").closest("button")).not.toBeDisabled();
  });

  it("warns when a line's legs don't connect", () => {
    renderEditor([{}], [leg("NLRTM", "BEANR", 0), leg("DEHAM", "USNYC", 0)]);
    expect(screen.getByText(/Leg 1 discharges at/)).toHaveTextContent("Leg 1 discharges at BEANR, but leg 2 loads from DEHAM");
  });

  it("allows one pick-up location per line", () => {
    renderEditor([{}], [leg("NLRTM", "USNYC", 0, { polLocType: "Door", polCarrierHaulage: true, polHaulageLocations: "DEBER NLAMS" })]);
    expect(screen.getByText(/One pick-up location per line/)).toBeInTheDocument();
  });

  it("says which legs have no line yet and that each becomes its own line on save", () => {
    renderEditor([{}], [leg("NLRTM", "USNYC", 0), leg("CNSHA", "USLAX", -1)]);
    expect(screen.getByText(/1 leg without a routing line \(CNSHA → USLAX\) will each become their own line/)).toBeInTheDocument();
  });
});

describe("RoutingLinesEditor — edits reach the contract form", () => {
  it("reports a line name, its transit, adding a leg and removing the line", () => {
    const h = renderEditor([{ name: "" }], [leg("NLRTM", "USNYC", 0)]);
    fireEvent.change(screen.getByLabelText("Line 1 name"), { target: { value: "Rotterdam direct" } });
    expect(h.onUpdateRouting).toHaveBeenCalledWith(0, { name: "Rotterdam direct" });
    fireEvent.click(screen.getByText("＋ Add leg"));
    expect(h.onAddLeg).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByLabelText("Remove line 1"));
    expect(h.onRemoveRouting).toHaveBeenCalledWith(0);
  });

  it("upper-cases a service code and passes the leg's position in the contract's leg list", () => {
    // The line's only leg is the SECOND leg of the contract (index 1).
    const h = renderEditor([{}, {}], [leg("CNSHA", "USLAX", 1), leg("NLRTM", "USNYC", 0)]);
    fireEvent.change(screen.getByLabelText("Line 1 leg 1 service code"), { target: { value: "al5" } });
    expect(h.onUpdateLeg).toHaveBeenCalledWith(1, { vesselService: "AL5" });
    fireEvent.click(screen.getByLabelText("Remove line 1 leg 1"));
    expect(h.onRemoveLeg).toHaveBeenCalledWith(1);
  });

  it("switching an end to Door turns carrier haulage on; back to Terminal clears its location", () => {
    const h = renderEditor([{}], [leg("NLRTM", "USNYC", 0)]);
    const fromCell = screen.getByTestId("routing-line-0-leg-0");
    fireEvent.click(within(fromCell).getAllByText("Door")[0]);
    expect(h.onUpdateLeg).toHaveBeenCalledWith(0, { polLocType: "Door", polCarrierHaulage: true });
    fireEvent.click(within(fromCell).getAllByText("Terminal")[0]);
    expect(h.onUpdateLeg).toHaveBeenCalledWith(0, { polLocType: "Terminal", polCarrierHaulage: false, polHaulageLocations: "" });
  });

  it("offers the pick-up location field only on a Door/CY start of the line, upper-cased", () => {
    const h = renderEditor([{}], [leg("DEHAM", "USNYC", 0, { polLocType: "Door", polCarrierHaulage: true })]);
    fireEvent.change(screen.getByLabelText("Pick-up location"), { target: { value: "deber" } });
    expect(h.onUpdateLeg).toHaveBeenCalledWith(0, { polHaulageLocations: "DEBER" });
    expect(screen.queryByLabelText("Delivery location")).toBeNull(); // the To end is a Terminal
  });
});

describe("RoutingLinesEditor — linked ports", () => {
  it("lists the ports linked to a port flagged 'linked ports accepted'", async () => {
    api.portLinks.mockResolvedValue([{ unlocode: "NLAMS", name: "Amsterdam" }]);
    renderEditor([{}], [leg("NLRTM", "USNYC", 0, { polLinkedAllowed: true })]);
    fireEvent.click(screen.getByTestId("linked-pol-NLRTM"));
    expect(await screen.findByText("NLAMS")).toBeInTheDocument();
    expect(api.portLinks).toHaveBeenCalledWith("NLRTM");
  });

  it("says when the flag has no effect because nothing is linked", async () => {
    api.portLinks.mockResolvedValue([]);
    renderEditor([{}], [leg("NLRTM", "USNYC", 0, { polLinkedAllowed: true })]);
    fireEvent.click(screen.getByTestId("linked-pol-NLRTM"));
    expect(await screen.findByTestId("linked-ports-empty")).toHaveTextContent("No linked ports are registered for NLRTM");
  });
});
