import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DatePicker from "./DatePicker";

// The calendar is portaled to <body>: inside a backdrop-filter glass card (the Shipping
// Instructions page's SI Cutoff) a position: fixed popover rendered inline resolves against the
// card, not the viewport, and opened at the bottom-right of the screen.

const renderInGlass = (props = {}) => render(
  <div data-testid="glass" style={{ backdropFilter: "blur(20px)" }}>
    <DatePicker id="dp" label="SI Cutoff" value="2026-10-01" onChange={() => {}} {...props} />
  </div>
);
const openPicker = container => fireEvent.click(container.querySelector("#dp button"));

describe("DatePicker", () => {
  it("renders the calendar outside its glass-card ancestor, on <body>", () => {
    const { container } = renderInGlass();
    openPicker(container);
    const day = screen.getByRole("button", { name: "15" });
    expect(screen.getByTestId("glass").contains(day)).toBe(false);
    expect(document.body.contains(day)).toBe(true);
    // Tests reach the calendar as #<id>-calendar (lane-steering.cy.js), since it's outside the field.
    expect(document.getElementById("dp-calendar").contains(day)).toBe(true);
  });

  it("a click inside the portaled calendar picks the day rather than closing it as an outside click", () => {
    const onChange = vi.fn();
    const { container } = renderInGlass({ onChange });
    openPicker(container);
    const day = screen.getByRole("button", { name: "15" });
    fireEvent.mouseDown(day);
    fireEvent.click(day);
    expect(onChange).toHaveBeenCalledWith("2026-10-15");
  });

  it("closes on a click outside both the field and the calendar", () => {
    const { container } = renderInGlass();
    openPicker(container);
    expect(screen.getByRole("button", { name: "15" })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("button", { name: "15" })).toBeNull();
  });
});
