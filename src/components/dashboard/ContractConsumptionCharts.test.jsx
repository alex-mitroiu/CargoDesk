import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ContractBarsChart, ContractTrendChart, ContractBreakdown, UnitSwitch } from "./ContractConsumptionCharts";
import { buildContractRows } from "../../utils/contractConsumption";

// Recharts' ResponsiveContainer (the breakdown Sankey) needs it; jsdom doesn't have one.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const hz = {
  bg: "#080b15", surface: "#111", surfaceStrong: "#222", border: "#333", borderSoft: "#2a2a2a", ink: "#fff", inkMuted: "#aaa", inkFaint: "#666",
  gradCyan: ["#38d4e8", "#3987e5"], good: "#22c55e", warning: "#fab219", critical: "#f0526b", available: "#a78bfa",
  chartCategorical: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"], cardShadow: "none",
  fontDisplay: "Sora", fontBody: "Jakarta", fontMono: "Plex Mono",
};

const contractMap = {
  "C-A": { carrierCode: "HLCU", contractNumber: "HLCU-TATL", contractRef: "EUN-USEC-A" },
  "C-B": { carrierCode: "HLCU", contractNumber: "HLCU-TATL", contractRef: "EUN-USEC-B", namedAccount: "Nordic Home Retail AB" },
  "C-E": { carrierCode: "EGLV", contractNumber: "EGLV-TPAC" },
};
const allocations = [
  { id: "AL-A", contractId: "C-A", allocatedTEU: 120 }, { id: "AL-B", contractId: "C-B", allocatedTEU: 60 },
  { id: "AL-E", contractId: "C-E", allocatedTEU: 200 },
];
const shipments = [
  { id: "S1", allocationId: "AL-A", bookingStatus: "Confirmed", teu: 70, spaceSelection: "suggested" },
  { id: "S2", allocationId: "AL-A", bookingStatus: "Pending", teu: 8, spaceSelection: "direct" },
  { id: "S3", allocationId: "AL-B", bookingStatus: "Confirmed", teu: 60 },
  { id: "S4", allocationId: "AL-B", bookingStatus: "Created", teu: 4, spaceSelection: "overbooked" },
  { id: "S5", allocationId: "AL-E", bookingStatus: "Confirmed", teu: 19, spaceSelection: "direct" },
];
const rows = buildContractRows({ allocations, shipments, contractMap, teuOfShipment: s => s.teu });

describe("Allocation by contract bars", () => {
  it("draws one bar per contract number, fullest first, and selects on click or Enter", () => {
    const onSelect = vi.fn();
    render(<ContractBarsChart rows={rows} selectedKey={rows[0].key} onSelect={onSelect} unit="teu" hz={hz} />);
    const bars = screen.getAllByRole("button", { name: /Show breakdown/ });
    expect(bars.map(b => b.getAttribute("aria-label"))).toEqual(["HLCU-TATL: 79% in use. Show breakdown", "EGLV-TPAC: 10% in use. Show breakdown"]);
    fireEvent.click(bars[1]);
    expect(onSelect).toHaveBeenCalledWith("EGLV|EGLV-TPAC");
    fireEvent.keyDown(bars[0], { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("HLCU|HLCU-TATL");
  });

  it("shows the carrier + contract tooltip with TEU and % whatever the unit", () => {
    render(<ContractBarsChart rows={rows} selectedKey={null} onSelect={() => {}} unit="pct" hz={hz} />);
    fireEvent.pointerMove(screen.getAllByRole("button", { name: /Show breakdown/ })[0], { clientX: 50, clientY: 50 });
    const tip = screen.getByTestId("consumption-tooltip");
    expect(tip).toHaveTextContent("HLCU");
    expect(tip).toHaveTextContent("HLCU-TATL");
    expect(tip).toHaveTextContent("130 TEU");            // confirmed, in TEU even in % mode
    expect(tip).toHaveTextContent("EUN-USEC-B is 4 TEU over its own allocation");
  });

  it("labels the axis in % of allocation when switched", () => {
    const { container } = render(<ContractBarsChart rows={rows} selectedKey={null} onSelect={() => {}} unit="pct" hz={hz} />);
    expect(container).toHaveTextContent("% of allocation");
  });
});

describe("unit switch", () => {
  it("reports the chosen unit", () => {
    const onChange = vi.fn();
    render(<UnitSwitch unit="teu" onChange={onChange} hz={hz} />);
    expect(screen.getByTestId("consumption-unit-teu")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("consumption-unit-pct"));
    expect(onChange).toHaveBeenCalledWith("pct");
  });
});

describe("weekly trend", () => {
  const trend = {
    weeks: ["17 Aug", "24 Aug", "31 Aug", "7 Sep", "14 Sep", "21 Sep"].map((label, i) => ({ label, start: `w${i}`, end: `w${i}e` })),
    series: [{ key: "HLCU|HLCU-TATL", carrierCode: "HLCU", contractNumber: "HLCU-TATL", values: [0, 0, 0, 0, 26, 0] }],
  };
  it("shows the table in the selected unit, and legend entries select a contract", () => {
    const onSelect = vi.fn();
    render(<ContractTrendChart trend={trend} allocByKey={{ "HLCU|HLCU-TATL": 180 }} selectedKey={null} onSelect={onSelect} unit="pct" hz={hz} asTable />);
    const table = screen.getByTestId("consumption-trend-table");
    expect(within(table).getByText("14%")).toBeInTheDocument(); // 26 / 180
    fireEvent.click(screen.getByTestId("consumption-trend-legend-HLCU|HLCU-TATL"));
    expect(onSelect).toHaveBeenCalledWith("HLCU|HLCU-TATL");
  });
});

describe("contract breakdown", () => {
  it("states the split in the selected unit and counts how each reference's space was picked", () => {
    const { rerender } = render(<ContractBreakdown row={rows[0]} unit="teu" hz={hz} />);
    const stats = screen.getByTestId("consumption-breakdown-stats");
    expect(stats).toHaveTextContent("180 TEU");
    expect(stats).toHaveTextContent("Over allocation+4 TEU");
    const table = screen.getByTestId("consumption-reference-table");
    const rowA = within(table).getByText("EUN-USEC-A").closest("tr");
    expect(within(rowA).getAllByRole("cell").map(c => c.textContent)).toEqual(["EUN-USEC-A", "All accounts", "120 TEU", "70 TEU", "8 TEU", "42 TEU", "1", "1", "0", "0"]);
    const rowB = within(table).getByText("EUN-USEC-B").closest("tr");
    expect(within(rowB).getAllByRole("cell").slice(5).map(c => c.textContent)).toEqual(["4 TEU over", "0", "0", "1", "1"]);

    rerender(<ContractBreakdown row={rows[0]} unit="pct" hz={hz} />);
    expect(screen.getByTestId("consumption-breakdown-stats")).toHaveTextContent("Allocated100%");
    expect(within(screen.getByTestId("consumption-reference-table")).getByText("EUN-USEC-A").closest("tr")).toHaveTextContent("67%");
  });
});
