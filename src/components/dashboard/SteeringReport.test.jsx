import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// The tab only shows what GET /api/reports/steering counted (routes/where-to-book.js); these tests pin
// what the reader sees and what it asks the server for. `api.reports.steering` is the real name in
// src/api.js.
const REPORT = vi.hoisted(() => ({
  from: "2026-10-01", to: "2026-10-31", total: 9, followed: 4, notFollowed: 2, inRate: 6, rate: 66.7,
  counts: { steered: 4, rebooked: 0, out_of_order: 1, other_contract: 0, other_carrier: 0, spot: 1, other_loop: 0, not_covered: 2, not_recorded: 1 },
  byLane: [{ lane: "EU-N → NAM", inRate: 6, followed: 4, notFollowed: 2, notCovered: 0, notRecorded: 1, rate: 66.7 },
    { lane: "FE → EU-N", inRate: 0, followed: 0, notFollowed: 0, notCovered: 2, notRecorded: 0, rate: null }],
  byCarrier: [{ carrierCode: "HLCU", shipments: 3, followed: 2, notFollowed: 1 }],
  notFollowedShipments: [
    { id: "SHP-K2V81Q", etd: "2026-10-28", lane: "EU-N → NAM", carrierCode: "HLCU", contractType: "Central", contractRef: "suck_it_up", verdict: "out_of_order", rank: 2,
      pick: { rank: 1, carrierCode: "MAEU", contractNumber: "MAEU-1", freeTeu: 8, options: 3 }, reason: "Customer asked for Hapag-Lloyd" },
    { id: "SHP-Q93JNA", etd: "2026-10-21", lane: "EU-N → NAM", carrierCode: "CMDU", contractType: "SPOT", contractRef: "Q-1", verdict: "spot", rank: null,
      pick: { rank: 1, carrierCode: "MAEU", contractNumber: "MAEU-1", freeTeu: 8, options: 3 }, reason: "" },
  ],
}));
vi.mock("../../api", () => ({ api: { reports: { steering: vi.fn(() => Promise.resolve(REPORT)) } } }));

import SteeringReport from "./SteeringReport";
import { api } from "../../api";

const hz = { surface: "#111", surfaceStrong: "#222", border: "#333", borderSoft: "#2a2a2a", cardShadow: "none", ink: "#fff", inkMuted: "#aaa",
  good: "#22c55e", warning: "#fab219", critical: "#f0526b", available: "#a78bfa", gradCyan: ["#38d4e8", "#3987e5"],
  fontDisplay: "Sora", fontBody: "Jakarta", fontMono: "Plex" };

describe("Dashboard → Steering", () => {
  beforeEach(() => api.reports.steering.mockClear());

  it("asks for the Dashboard's dates and carrier filter", async () => {
    render(<SteeringReport hz={hz} rangeStart="2026-10-01" rangeEnd="2026-10-31" carriers={["MAEU", "HLCU"]} />);
    await screen.findByTestId("steering-report");
    expect(api.reports.steering).toHaveBeenCalledWith({ from: "2026-10-01", to: "2026-10-31", carrier: "HLCU,MAEU" });
  });

  it("shows the rate, the counts and what's outside the rate", async () => {
    render(<SteeringReport hz={hz} rangeStart="2026-10-01" rangeEnd="2026-10-31" />);
    const rate = await screen.findByTestId("steering-report-rate");
    expect(rate).toHaveTextContent("66.7%");
    expect(rate).toHaveTextContent("4 of 6 shipments followed the steering");
    expect(rate).toHaveTextContent("3 more outside the rate: 2 not covered");
    expect(screen.getByTestId("steering-report-count-out_of_order")).toHaveTextContent("Out of order 1");
    expect(within(screen.getByTestId("steering-report-lanes")).getByText("FE → EU-N")).toBeInTheDocument();
  });

  it("lists the shipments that didn't follow, each opening in a new tab, with the pick and the reason", async () => {
    render(<SteeringReport hz={hz} rangeStart="2026-10-01" rangeEnd="2026-10-31" />);
    const table = await screen.findByTestId("steering-report-not-followed");
    const link = within(table).getByRole("link", { name: "SHP-K2V81Q" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("href")).toMatch(/#shipments\/SHP-K2V81Q$/);
    expect(table).toHaveTextContent("#1 MAEU · 8 TEU free");
    expect(table).toHaveTextContent("Customer asked for Hapag-Lloyd");
    expect(table).toHaveTextContent("No reason given");
  });

  it("filters by trade lane", async () => {
    render(<SteeringReport hz={hz} rangeStart="2026-10-01" rangeEnd="2026-10-31" />);
    fireEvent.change(await screen.findByTestId("steering-report-lane"), { target: { value: "EU-N → NAM" } });
    await waitFor(() => expect(api.reports.steering).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31", lane: "EU-N → NAM" }));
  });
});
