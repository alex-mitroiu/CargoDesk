import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MatchedShipmentsTable, KpiRing } from "./DashboardPage";

// Regression test for a real bug found via live exploratory QA: MatchedShipmentsTable (the
// Overview tab's "Shipments in Period" table, "Space Config" column) used to match a shipment to
// a space allocation by carrier+pol/pod alone, instead of the real allocationId link every other
// computation on this page already uses (consumedMap, chartData, carrierTrends,
// ContractConsumptionView — see their own "2026-09 Space Configuration spec, gap #1" comments).
// That heuristic both false-positives (shows "Matched" for a shipment that was never actually
// linked, so it contributes 0 to that config's real totals shown everywhere else) and
// false-negatives (shows "No config match" for a shipment linked via a linked-port equivalence
// the heuristic can't see) — both reproduced live against real data before this fix.

const ALLOCATIONS = [
  { id: "ALC-REAL1", carrierCode: "MAEU", pol: "CNSHA", pod: "USLAX", allocatedTEU: 1200 },
  { id: "ALC-REAL2", carrierCode: "HLCU", pol: "NLAMS", pod: "USNYC", allocatedTEU: 500 }, // linked-port scenario: real allocation's own pol differs from the shipment's pol below
];

const CARRIERS = [{ code: "MAEU", name: "Maersk" }, { code: "HLCU", name: "Hapag-Lloyd" }];

const SHIPMENTS = [
  // Genuinely linked — should show Matched.
  { id: "SHP-LINKED", carrierCode: "MAEU", pol: "CNSHA", pod: "USLAX", allocationId: "ALC-REAL1", contractType: "Central", status: "Active" },
  // Same carrier+pol/pod as ALC-REAL1 but never actually linked — the false-positive case.
  { id: "SHP-UNLINKED", carrierCode: "MAEU", pol: "CNSHA", pod: "USLAX", allocationId: "", contractType: "SPOT", status: "Active" },
  // Linked to ALC-REAL2 despite a different pol (NLRTM vs the allocation's own NLAMS) — simulates
  // a linked-port equivalence the old carrier+pol/pod heuristic could never recognize.
  { id: "SHP-VIA-LINKED-PORT", carrierCode: "HLCU", pol: "NLRTM", pod: "USNYC", allocationId: "ALC-REAL2", contractType: "Central", status: "Active" },
];

function renderTable() {
  return render(
    <MatchedShipmentsTable
      shipments={SHIPMENTS}
      containers={[]}
      carriers={CARRIERS}
      activeAllocations={ALLOCATIONS}
      teuDefs={new Map()}
    />
  );
}

describe("MatchedShipmentsTable — Space Config column matches by allocationId, not carrier+pol/pod", () => {
  it("shows Matched for a shipment genuinely linked via allocationId", () => {
    renderTable();
    const row = screen.getByText("SHP-LINKED").closest("div");
    expect(row).toHaveTextContent("Matched");
  });

  it("does NOT show Matched for a shipment that merely resembles a match but has no real allocationId (false-positive case)", () => {
    renderTable();
    const row = screen.getByText("SHP-UNLINKED").closest("div");
    expect(row).not.toHaveTextContent("Matched");
    expect(row).toHaveTextContent("No config match");
  });

  it("shows Matched for a shipment linked via allocationId even when its own pol differs from the allocation's (linked-port case, false-negative fix)", () => {
    renderTable();
    const row = screen.getByText("SHP-VIA-LINKED-PORT").closest("div");
    expect(row).toHaveTextContent("Matched");
  });
});

describe("KpiRing — confirmed and pending confirmation drawn as separate arcs", () => {
  const renderRing = props => render(<KpiRing allocated={830} confirmed={72} pending={41} rejected={5} remaining={758} {...props} />);
  const arcs = () => [...screen.getByTestId("consumption-ring").querySelectorAll("circle")].slice(1);

  it("shows the confirmed share in the centre and the pending share under it", () => {
    renderRing();
    expect(screen.getByTestId("consumption-ring")).toHaveTextContent("8.7%");
    expect(screen.getByTestId("consumption-ring-pending")).toHaveTextContent("+4.9% pending");
    expect(arcs()).toHaveLength(2);
  });

  it("still prints a three-digit pending figure, while the drawn arcs never pass the full circle", () => {
    renderRing({ confirmed: 540, pending: 910 });
    expect(screen.getByTestId("consumption-ring-pending")).toHaveTextContent("+109.6% pending");
    const circ = 2 * Math.PI * 72;
    const drawn = arcs().reduce((sum, el) => sum + Number(el.getAttribute("stroke-dasharray").split(" ")[0]), 0);
    expect(drawn).toBeLessThanOrEqual(circ + 0.001);
  });

  it("draws no pending arc when nothing is pending", () => {
    renderRing({ pending: 0 });
    expect(screen.getByTestId("consumption-ring-pending")).toHaveTextContent("+0.0% pending");
    expect(arcs()).toHaveLength(1);
  });
});
