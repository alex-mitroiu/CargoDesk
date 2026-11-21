import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FoldSection, FactsPills, useFolds } from "./FoldSection";

// A page with one foldable section, its open state kept by useFolds (as Carrier Booking → Details keeps its two).
function Page({ userId }) {
  const folds = useFolds(["demo.offices"], userId);
  return (
    <FoldSection id="demo-offices" testId="demo-offices" label="Carrier offices" tag="HLCU" open={folds.isOpen("demo.offices")}
      onToggle={() => folds.toggle("demo.offices")} summary={<FactsPills testId="demo-pills" items={[
        { label: "Booking", value: "Rotterdam Cargo Services B.V.", tail: "NLRTM" }, { label: "Import office", value: "none set", warn: true }]} />}>
      <div data-testid="demo-body">Four office tiles</div>
    </FoldSection>
  );
}

beforeEach(() => localStorage.clear());

describe("FoldSection + useFolds (decision A: open first, then remembered per user in this browser)", () => {
  it("starts open, folds to its summary, and stays folded after a reload", () => {
    const { unmount } = render(<Page userId="USR-TEST" />);
    expect(screen.getByTestId("demo-body")).toBeVisible();
    expect(screen.queryByTestId("demo-offices-summary")).toBeNull();
    fireEvent.click(screen.getByTestId("demo-offices-fold"));
    expect(screen.getByTestId("demo-body")).not.toBeVisible();
    // The arrow names its body, which is still there, hidden (audit B3).
    expect(document.getElementById(screen.getByTestId("demo-offices-fold").getAttribute("aria-controls"))).toHaveAttribute("hidden");
    expect(screen.getByTestId("demo-pills")).toHaveTextContent("Booking Rotterdam Cargo Services B.V. · NLRTM");
    expect(screen.getByTestId("demo-pills")).toHaveTextContent("Import office none set");
    expect(screen.getByTestId("demo-offices-fold")).toHaveAttribute("aria-expanded", "false");
    unmount();
    render(<Page userId="USR-TEST" />);
    expect(screen.getByTestId("demo-offices")).toHaveAttribute("data-open", "false");
  });

  it("another user in the same browser keeps their own choice", () => {
    const { unmount } = render(<Page userId="USR-TEST" />);
    fireEvent.click(screen.getByTestId("demo-offices-fold"));
    unmount();
    render(<Page userId="USR-SAM" />);
    expect(screen.getByTestId("demo-offices")).toHaveAttribute("data-open", "true");
  });

  it("left uncontrolled, a section keeps its own state", () => {
    render(<FoldSection id="x" testId="x" label="Payment terms (CPI)"><span data-testid="x-body">table</span></FoldSection>);
    fireEvent.click(screen.getByTestId("x-fold"));
    expect(screen.getByTestId("x-body")).not.toBeVisible();
  });
});
