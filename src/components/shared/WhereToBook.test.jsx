import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import WhereToBookPanel, { spaceOf, allocFromOption, steeringCheck, steeringChipOf, SteeringWarningDialog } from "./WhereToBook";

// The panel only shows what GET /api/where-to-book worked out (lib/where-to-book.js); these tests
// pin what the booking desk sees for each status and which options it can book.

const space = (over = {}) => ({ id: "ALC-W", allocatedTEU: 15, confirmedTEU: 0, pendingTEU: 4, freeTEU: 11, spaceBasis: "week", week: "2026-10-26", weekNumber: 44,
  effectiveDate: "2026-09-29", endDate: "2026-10-31", customerId: "", customerName: "", loopCode: "AL1", commodityCode: "9999", matchedRoutingId: "R-1", ...over });
const answer = (over = {}) => ({
  lane: "EU-N → NAM", teu: 4,
  line: { id: "LST-1", customerId: "", customerName: "", validFrom: "2026-10-01", validTo: "2026-12-31", autoSwitch: false, note: "Book HLCU first" },
  options: [
    { rank: 1, carrierCode: "HLCU", contractId: "C-1", contractNumber: "EC-HLCU", contractRef: "REF00404", note: "", status: "skipped", reason: "space for commodity 001404 only", orderOnly: false, freeTeu: null, space: [] },
    { rank: 2, carrierCode: "HLCU", contractId: "C-2", contractNumber: "suck_it_up", contractRef: "feathers", note: "Weekly allocation", status: "available", reason: "", orderOnly: false, freeTeu: 11, space: [space()] },
    { rank: 3, carrierCode: "CMDU", contractId: "C-3", contractNumber: "CMDU-CH", contractRef: "REF1", note: "", status: "available", reason: "", orderOnly: true, freeTeu: null, space: [] },
  ],
  pick: { rank: 2, carrierCode: "HLCU", contractId: "C-2", allocationId: "ALC-W", orderOnly: false, freeTeu: 11, overbooking: false, allFull: false },
  ...over,
});

describe("WhereToBookPanel", () => {
  it("shows the line, its note, and each option's status", () => {
    render(<WhereToBookPanel answer={answer()} onBook={() => {}} />);
    expect(screen.getByText(/EU-N → NAM/)).toBeInTheDocument();
    expect(screen.getByTestId("where-to-book-line-note")).toHaveTextContent("Book HLCU first");
    expect(screen.getByTestId("where-to-book-option-1")).toHaveTextContent("SKIPPED");
    expect(screen.getByTestId("where-to-book-option-1")).toHaveTextContent("Skipped: space for commodity 001404 only");
    expect(screen.getByTestId("where-to-book-option-2")).toHaveTextContent("THE PICK");
    expect(screen.getByTestId("where-to-book-option-2")).toHaveTextContent("week 44, 15 TEU a week");
    expect(screen.getByTestId("where-to-book-option-2")).toHaveTextContent("11 of 15 TEU free");
    expect(screen.getByTestId("where-to-book-option-3")).toHaveTextContent("order only, no cap");
  });

  it("books the pick, or a lower available option, but never a skipped one", () => {
    const onBook = vi.fn();
    render(<WhereToBookPanel answer={answer()} onBook={onBook} />);
    expect(within(screen.getByTestId("where-to-book-option-1")).queryByRole("button")).toBeNull();
    fireEvent.click(screen.getByTestId("where-to-book-book-2"));
    expect(onBook).toHaveBeenLastCalledWith(expect.objectContaining({ rank: 2 }));
    fireEvent.click(screen.getByTestId("where-to-book-book-3"));
    expect(onBook).toHaveBeenLastCalledWith(expect.objectContaining({ rank: 3 }));
    expect(screen.getByTestId("where-to-book-book-2")).toHaveTextContent("Book on #2");
    expect(screen.getByTestId("where-to-book-book-3")).toHaveTextContent("Book here");
  });

  it("says when every option is full and the pick overbooks", () => {
    const a = answer();
    a.options[1] = { ...a.options[1], status: "full", freeTeu: 0, space: [space({ freeTEU: 0, pendingTEU: 15 })] };
    a.options[2] = { ...a.options[2], status: "skipped", reason: "the contract is withdrawn", orderOnly: false };
    render(<WhereToBookPanel answer={{ ...a, pick: { ...a.pick, overbooking: true, allFull: true } }} onBook={() => {}} />);
    expect(screen.getByTestId("where-to-book-option-2")).toHaveTextContent("Full in week 44");
    expect(screen.getByTestId("where-to-book-book-2")).toHaveTextContent("Book on #2 (overbook)");
    expect(screen.getByText(/Every option is full/)).toBeInTheDocument();
  });

  it("says so when the lane has no steering", () => {
    render(<WhereToBookPanel answer={{ lane: "FE → EU-N", line: null, options: [], pick: null }} />);
    expect(screen.getByTestId("where-to-book-none")).toHaveTextContent("No steering for FE → EU-N");
  });
});

describe("helpers", () => {
  it("books on the first configuration with free space", () => {
    const o = { space: [space({ id: "A", freeTEU: 0 }), space({ id: "B", freeTEU: 3 })] };
    expect(spaceOf(o).id).toBe("B");
    expect(spaceOf({ space: [] })).toBeNull();
  });
  it("builds the picker's space configuration from an option", () => {
    const o = answer().options[1];
    const a = allocFromOption(o, o.space[0], { pol: "NLRTM", pod: "USNYC" });
    expect(a).toMatchObject({ id: "ALC-W", contractId: "C-2", carrierCode: "HLCU", matchedRoutingId: "R-1", remainingTEU: 15, weekNumber: 44, pol: "NLRTM" });
  });
});

describe("the out-of-order check (Story 3)", () => {
  it("asks why for a lower option while a higher one has space", () => {
    const a = answer();   // #1 skipped, #2 available (the pick), #3 available (order only)
    expect(steeringCheck(a, "C-2")).toBeNull();
    expect(steeringCheck(a, "C-3")).toMatchObject({ kind: "out_of_order", higher: { rank: 2 }, booked: { rank: 3 } });
    expect(steeringCheck(a, "C-OTHER")).toMatchObject({ kind: "off_line", higher: { rank: 2 } });
    expect(steeringCheck(a, "", { spot: true })).toMatchObject({ kind: "spot", higher: { rank: 2 } });
  });
  it("doesn't ask when nothing higher has space, or there's no line", () => {
    const a = answer();
    a.options[1] = { ...a.options[1], status: "full" };
    a.options[2] = { ...a.options[2], status: "full" };
    expect(steeringCheck(a, "C-3")).toBeNull();
    expect(steeringCheck(a, "C-OTHER")).toBeNull();
    expect(steeringCheck({ line: null, options: [] }, "C-3")).toBeNull();
  });
  it("needs a reason before booking anyway", () => {
    const onAnyway = vi.fn(), onInstead = vi.fn();
    const check = steeringCheck(answer(), "C-3");
    render(<SteeringWarningDialog check={check} choiceLabel="CMDU CMDU-CH" onAnyway={onAnyway} onInstead={onInstead} onCancel={() => {}} />);
    expect(screen.getByText(/#2 HLCU suck_it_up has 11 TEU free in week 44/)).toBeInTheDocument();
    expect(screen.getByTestId("steering-warning-anyway")).toBeDisabled();
    fireEvent.change(screen.getByTestId("steering-warning-reason"), { target: { value: "Customer asked for CMA CGM" } });
    fireEvent.click(screen.getByTestId("steering-warning-anyway"));
    expect(onAnyway).toHaveBeenCalledWith("Customer asked for CMA CGM");
    fireEvent.click(screen.getByTestId("steering-warning-instead"));
    expect(onInstead).toHaveBeenCalled();
  });
});

describe("the verdict chip", () => {
  it("says how the shipment was steered", () => {
    expect(steeringChipOf({ steeringVerdict: "steered", steeringRank: 1, steeringPick: { options: 3 } })).toMatchObject({ tone: "good", label: "#1 of 3 · steered" });
    const ooo = steeringChipOf({ steeringVerdict: "out_of_order", steeringRank: 3, steeringReason: "Customer asked",
      steeringPick: { rank: 1, carrierCode: "HLCU", contractNumber: "EC-HLCU", freeTeu: 40, options: 3 } });
    expect(ooo).toMatchObject({ tone: "warn", label: "#3 of 3 · out of order" });
    expect(ooo.title).toBe("#1 HLCU EC-HLCU had 40 TEU free. Reason: Customer asked");
    expect(steeringChipOf({ steeringVerdict: "" })).toBeNull();
    expect(steeringChipOf({ steeringVerdict: "customer_own" })).toBeNull();
  });
});
