import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

// Contracts & Schedules, Trade Horizon next (2026-11-06): the contract card's space panel, which takes over
// from the charges on a shipment that books against a space configuration, and the live Save checks under the
// route table's pill look. The api mock mirrors the real api.js (every leaf resolves []), as App.test.jsx does.
vi.mock("../../../api", async () => {
  const actual = await vi.importActual("../../../api");
  const mockDeep = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [
    k, typeof v === "function" ? vi.fn().mockResolvedValue([]) : (v && typeof v === "object") ? mockDeep(v) : v,
  ]));
  return { ...actual, api: mockDeep(actual.api) };
});

import { ContractCard, SpacePanel, CarrierOfficeTile } from "./SchedulesParts";
import { LegsTable } from "../ShipmentFormPage";
import { HZ_LEGACY_THEME } from "../shipmentDetailTheme";

const hexToRgb = h => { const n = parseInt(h.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };

const SPACE = { id: "AL1", carrierCode: "MAEU", pol: "NLRTM", pod: "USNYC", spaceBasis: "week", weekNumber: 46,
  allocatedTEU: 20, confirmedTEU: 8, pendingTEU: 6, awaitingCarrierTEU: 4, notBookedTEU: 2, rejectedTEU: 0, remainingTEU: 12,
  effectiveDate: "2026-09-01", endDate: "2027-03-31" };
const SHIPMENT = { id: "SHP-T1", contractType: "Central", contractId: "CT1", contractRef: "MAEU-SC-2026-0418", carrierCode: "MAEU",
  allocationId: "AL1", etd: "2026-11-20", bookingStatus: "Pending" };
const DETAIL = { contractNumber: "MAEU-SC-2026-0418", status: "Active", validFrom: "2026-09-01", validTo: "2027-03-31", legs: [],
  rates: [{ id: "r1", serviceCode: "OF", amount: 1650, currency: "USD", unit: "per_container", containerType: "40HC" },
          { id: "r2", serviceCode: "BAF", amount: 310, currency: "USD", unit: "per_container", containerType: "40HC" }] };

describe("SpacePanel", () => {
  it("shows the week's space as total, used, pending (awaiting + not booked) and remaining", () => {
    render(<SpacePanel space={{ ...SPACE, contractNumber: "MAEU-SC-2026-0418" }} shipmentTeu={4} bookingStatus="Pending" carrierCode="MAEU" />);
    expect(screen.getByTestId("schedules-space-week")).toHaveTextContent("Week 46, 20 TEU a week");
    expect(screen.getByTestId("shipment-schedules-space-config-section")).toHaveTextContent("MAEU-SC-2026-0418");
    expect(screen.getByTestId("space-fig-allocated")).toHaveTextContent("20TEUTotal this week");
    expect(screen.getByTestId("space-fig-used")).toHaveTextContent("8TEU");
    expect(screen.getByTestId("space-fig-pending")).toHaveTextContent("6TEUPending4 awaiting the carrier · 2 not booked yet");
    expect(screen.getByTestId("space-fig-remaining")).toHaveTextContent("12TEU");
    expect(screen.queryByTestId("space-fig-rejected")).toBeNull();
    expect(screen.getByTestId("space-summary-line")).toHaveTextContent("8 / 20 TEU confirmed (12 remaining) · +6 pending");
    expect(screen.getByTestId("space-free-line")).toHaveTextContent("6 TEU still free once every pending booking is confirmed.");
  });

  it("gives a period's validity when the space is held for the period", () => {
    render(<SpacePanel space={{ ...SPACE, spaceBasis: "period" }} shipmentTeu={4} bookingStatus={null} carrierCode="MAEU" />);
    expect(screen.getByTestId("shipment-schedules-space-config-section")).toHaveTextContent("Valid 01 Sep 2026 → 31 Mar 2027 · 20 TEU for the period");
    expect(screen.getByTestId("space-fig-allocated")).toHaveTextContent("20TEUTotal");
  });

  it.each([
    ["Pending", "4 TEU of the pending, awaiting MAEU's answer to its booking"],
    ["Confirmed", "4 TEU, used (the carrier confirmed its booking)"],
    ["Rejected", "4 TEU, rejected (the carrier declined its booking)"],
    [null, "4 TEU of the pending, not booked yet"],
  ])("says which bucket this shipment is in when its booking is %s", (status, text) => {
    render(<SpacePanel space={SPACE} shipmentTeu={4} bookingStatus={status} carrierCode="MAEU" />);
    expect(screen.getByTestId("shipment-schedules-space-this-shipment")).toHaveTextContent(`This shipment: ${text}`);
  });

  it("warns when every pending booking being confirmed would run over the space", () => {
    render(<SpacePanel space={{ ...SPACE, notBookedTEU: 12, pendingTEU: 16 }} shipmentTeu={4} bookingStatus={null} carrierCode="MAEU" />);
    expect(screen.getByTestId("space-free-line")).toHaveTextContent("4 TEU over the space if every pending booking is confirmed.");
  });

  it("reads an older response with only pendingTEU as not booked", () => {
    const { awaitingCarrierTEU: _a, notBookedTEU: _n, ...old } = SPACE;
    render(<SpacePanel space={old} shipmentTeu={4} bookingStatus={null} carrierCode="MAEU" />);
    expect(screen.getByTestId("space-fig-pending")).toHaveTextContent("0 awaiting the carrier · 6 not booked yet");
  });
});

// The test copy's steered shipment (SHP-LUNPGM, 6 Nov): one option, weekly space, booked here.
const ANSWER = { lane: "EU-N → NAM", line: { id: "LST-1", customerName: "", validFrom: "2026-11-06", validTo: "2027-01-31", autoSwitch: false },
  pick: { rank: 1 },
  options: [{ rank: 1, carrierCode: "MAEU", contractId: "CT1", contractNumber: "MAEU-SC-2026-0418", status: "available", orderOnly: false, note: "Weekly Thursday cut-off at Rotterdam",
    space: [{ id: "AL1", spaceBasis: "week", weekNumber: 49, allocatedTEU: 20, confirmedTEU: 6, pendingTEU: 9, awaitingCarrierTEU: 8, notBookedTEU: 1, rejectedTEU: 0, remainingTEU: 14, freeTEU: 5,
      effectiveDate: "2026-11-02", endDate: "2027-01-31" }] },
    { rank: 2, carrierCode: "MSCU", contractId: "CT2", contractNumber: "ZZCR148510-C", status: "available", orderOnly: true, note: "", space: [] }] };

describe("ContractCard — no charges; the space, or the steering with each option's space", () => {
  const card = props => render(<ContractCard shipment={SHIPMENT} contractDetail={DETAIL} canEdit={false} {...props} />);

  it("never lists the charges, nor their currency (Cost Entry has them)", () => {
    card({ space: SPACE, shipmentTeu: 4 });
    expect(screen.queryByTestId("shipment-schedules-contract-rates")).toBeNull();
    expect(screen.queryByTestId("shipment-schedules-contract-rates-toggle")).toBeNull();
    expect(screen.getByTestId("shipment-schedules-contract-details")).not.toHaveTextContent("Currency");
    expect(screen.queryByText(/Cost Entry/)).toBeNull();
  });

  it("shows its own space configuration when no steering line covers it", () => {
    card({ space: SPACE, shipmentTeu: 4 });
    expect(screen.getByTestId("shipment-schedules-space-config-section")).toBeInTheDocument();
    expect(screen.queryByTestId("shipment-schedules-steering")).toBeNull();
  });

  it("with a steering line: the line, each option with its space, booked here, the verdict; no separate space panel", () => {
    card({ space: SPACE, steering: ANSWER, shipmentTeu: 4,
      shipment: { ...SHIPMENT, steeringVerdict: "steered", steeringRank: 1, steeringPick: { options: 2 } } });
    expect(screen.queryByTestId("shipment-schedules-space-config-section")).toBeNull();
    expect(screen.getByTestId("shipment-schedules-steering-line")).toHaveTextContent("EU-N → NAM · for everyone · 06 Nov 2026 → 31 Jan 2027 · auto-switch off");
    expect(screen.getByTestId("shipment-schedules-steering-chip")).toHaveTextContent("#1 of 2 · steered");
    const first = screen.getByTestId("shipment-schedules-steering-option-1");
    expect(first).toHaveAttribute("data-booked", "true");
    expect(first).toHaveTextContent("booked here");
    expect(within(first).getByTestId("space-fig-pending")).toHaveTextContent("9TEUPending8 awaiting the carrier · 1 not booked yet");
    expect(within(first).getByTestId("space-free-line")).toHaveTextContent("5 TEU still free once every pending booking is confirmed.");
    expect(within(first).getByTestId("shipment-schedules-space-this-shipment")).toHaveTextContent("This shipment: 4 TEU of the pending, awaiting MAEU's answer");
    const second = screen.getByTestId("shipment-schedules-steering-option-2");
    expect(second).toHaveTextContent("order only");
    expect(second).toHaveTextContent("No space configured on this route");
  });

  it("booked off the steering: says what it should have been and offers to rebook", () => {
    const onChange = vi.fn();
    render(<ContractCard shipment={{ ...SHIPMENT, contractType: "SPOT", contractId: "", contractRef: "SPOT-Q-1", allocationId: "",
      steeringVerdict: "spot", steeringReason: "Customer asked for a faster transit",
      steeringPick: { rank: 1, carrierCode: "MAEU", contractNumber: "MAEU-SC-2026-0418", freeTeu: 5, options: 2 } }}
      contractDetail={null} canEdit isDirty={false} onChange={onChange} steering={ANSWER} shipmentTeu={4} />);
    expect(screen.getByTestId("shipment-schedules-steering-chip")).toHaveTextContent("SPOT while steered space was free");
    expect(screen.getByTestId("shipment-schedules-steering-option-1")).toHaveTextContent("the pick");
    expect(screen.getByTestId("shipment-schedules-steering-off")).toHaveTextContent("#1 MAEU MAEU-SC-2026-0418 had 5 TEU free. Reason: Customer asked for a faster transit");
    fireEvent.click(screen.getByTestId("shipment-schedules-steering-rebook"));
    expect(onChange).toHaveBeenCalled();
  });

  it("shows the linked contract's number when the shipment's own reference is blank", () => {
    card({ shipment: { ...SHIPMENT, contractRef: "" }, canEdit: true, onChange: () => {} });
    expect(screen.getByTestId("shipment-schedules-contract-summary")).toHaveTextContent("MAEU-SC-2026-0418");
    expect(screen.getByTestId("shipment-schedules-contract-btn")).toHaveTextContent("Change Contract");
  });

  it("says so when the linked configuration isn't active any more", () => {
    card({ spaceMissing: true });
    expect(screen.getByTestId("shipment-schedules-space-config-section")).toHaveTextContent("No active space configuration matches this shipment.");
  });
});

describe("LegsTable — pill look's live Save checks", () => {
  const leg = (id, pol, pod, extra = {}) => ({ id, legType: "SEA", pol, pod, polLocType: "Terminal", podLocType: "Terminal",
    etd: null, eta: null, carrierCode: "MAEU", vessel: "", voyage: "", ...extra });
  const table = legs => render(<LegsTable shipmentId={null} draftLegs={legs} canEdit showContractCols={false}
    hideDraftBanner theme={HZ_LEGACY_THEME} variant="pill" />);
  const check = key => screen.getByTestId(`shipment-form-leg-check-${key}`);

  it("ticks every check on a route that holds together", () => {
    table([leg("a", "NLRTM", "BEANR", { etd: "2026-11-20", eta: "2026-11-21" }), leg("b", "BEANR", "USNYC", { etd: "2026-11-23", eta: "2026-12-06" })]);
    for (const k of ["ports", "meet", "dates", "carrier"]) expect(check(k)).toHaveAttribute("data-ok", "true");
  });

  it("flags legs that don't meet, dates out of order, a missing port and a vessel without a carrier", () => {
    table([leg("a", "NLRTM", "BEANR", { etd: "2026-11-20", eta: "2026-11-25" }),
           leg("b", "DEHAM", "", { etd: "2026-11-23", vessel: "MAERSK KENSINGTON", carrierCode: "" })]);
    for (const k of ["ports", "meet", "dates", "carrier"]) expect(check(k)).toHaveAttribute("data-ok", "false");
    expect(within(screen.getByTestId("shipment-form-leg-chain-problems")).getByText(/ends at BEANR Terminal/)).toBeInTheDocument();
  });

  it("says what to do first when there are no legs", () => {
    table([]);
    expect(screen.getByTestId("shipment-form-legs-empty")).toHaveTextContent("No legs yet. + Add leg, then fill in From and To");
    expect(screen.queryByTestId("shipment-form-leg-checks")).toBeNull();
  });

  // Reported 2026-11-06: in dark mode a Loc. Type list showed white options on white (the pill's tint is
  // see-through, so the browser paints the open list on its own ground). Every option gets a solid surface.
  it("gives every select's options the theme's solid surface and text", () => {
    const pku = leg("p", "NLAMS", "NLRTM", { legType: "Pick-up", movementType: "Carrier's Haulage", carrierCode: "", movementBy: "Truck" });
    table([pku, leg("a", "NLRTM", "USNYC")]);
    const opts = [...document.querySelectorAll('[id="leg-row-p"] select option')];
    expect(opts.length).toBeGreaterThan(10); // Leg Type, Movement Type, both Loc. Types, Movement by
    for (const o of opts) {
      expect(o.style.background).toBe(HZ_LEGACY_THEME.surfaceSolid.startsWith("#") ? hexToRgb(HZ_LEGACY_THEME.surfaceSolid) : HZ_LEGACY_THEME.surfaceSolid);
      expect(o.style.color).not.toBe("");
    }
  });

  it("keeps the classic table free of the checks row", () => {
    render(<LegsTable shipmentId={null} draftLegs={[leg("a", "NLRTM", "USNYC")]} canEdit showContractCols={false} hideDraftBanner />);
    expect(screen.queryByTestId("shipment-form-leg-checks")).toBeNull();
  });
});

// Carrier offices (2026-11-16, §8.53): the tile says which office and why, offers the carrier's offices to the side
// that may change it, and lists the offices found twice via linked ports for a pick.
describe("CarrierOfficeTile", () => {
  const OFFICES = [{ id: "COF-MAD", name: "Hapag-Lloyd Spain Madrid", unlocode: "ESMAD" }, { id: "COF-BCN", name: "Hapag-Lloyd Spain Barcelona", unlocode: "ESBCN" }];
  const entry = over => ({ role: "booking", label: "Carrier booking office", side: "Export", port: "ESBCN", source: "auto", why: "row for ES",
    fallback: false, leftEmpty: false, candidates: [], office: { id: "COF-MAD", name: "Hapag-Lloyd Spain Madrid", unlocode: "ESMAD", locationName: "Madrid" }, ...over });

  it("shows the office, its location and why it was picked", () => {
    render(<CarrierOfficeTile entry={entry()} offices={OFFICES} canEdit={false} onPick={vi.fn()} />);
    expect(screen.getByTestId("shipment-carrier-office-booking-name").textContent).toBe("Hapag-Lloyd Spain Madrid");
    expect(screen.getByText("ESMAD · Madrid")).toBeTruthy();
    expect(screen.getByTestId("shipment-carrier-office-booking-why").textContent).toBe("Coverage: row for ES");
    expect(screen.queryByTestId("shipment-carrier-office-booking-edit-btn")).toBeNull();
  });

  it("says when the billing office falls back to the import office", () => {
    render(<CarrierOfficeTile entry={entry({ role: "billing_destination", label: "Carrier billing · destination", source: "fallback", fallback: true,
      why: "no billing row: the import office bills" })} offices={OFFICES} canEdit={false} onPick={vi.fn()} />);
    expect(screen.getByTestId("shipment-carrier-office-billing_destination-why").textContent).toBe("no billing row: the import office bills");
  });

  it("lets the side that may change it pick another office of the carrier", async () => {
    const onPick = vi.fn().mockResolvedValue();
    render(<CarrierOfficeTile entry={entry()} offices={OFFICES} canEdit onPick={onPick} />);
    fireEvent.click(screen.getByTestId("shipment-carrier-office-booking-edit-btn"));
    fireEvent.change(screen.getByTestId("shipment-carrier-office-booking-select"), { target: { value: "COF-BCN" } });
    fireEvent.click(screen.getByTestId("shipment-carrier-office-booking-save-btn"));
    expect(onPick).toHaveBeenCalledWith("booking", { officeId: "COF-BCN" });
  });

  it("lists two offices found via linked ports, each to pick", () => {
    const onPick = vi.fn().mockResolvedValue();
    render(<CarrierOfficeTile entry={entry({ office: null, source: null, why: "", candidates: [
      { officeId: "COF-A", officeName: "Rotterdam Line Office", via: "NLRTM" }, { officeId: "COF-B", officeName: "New York Line Office", via: "USNYC" }] })}
      offices={OFFICES} canEdit onPick={onPick} />);
    expect(screen.getByTestId("shipment-carrier-office-booking-why").textContent).toBe("2 offices match via linked ports: pick one");
    fireEvent.click(screen.getByTestId("shipment-carrier-office-booking-candidate-COF-B"));
    expect(onPick).toHaveBeenCalledWith("booking", { officeId: "COF-B" });
  });

  it("offers From coverage after a hand pick", () => {
    const onPick = vi.fn().mockResolvedValue();
    render(<CarrierOfficeTile entry={entry({ source: "manual", why: "picked by Alex" })} offices={OFFICES} canEdit onPick={onPick} />);
    fireEvent.click(screen.getByTestId("shipment-carrier-office-booking-coverage-btn"));
    expect(onPick).toHaveBeenCalledWith("booking", { fromCoverage: true });
  });
});
