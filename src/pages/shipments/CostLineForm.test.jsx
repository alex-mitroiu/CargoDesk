import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mirror the REAL api.js's shape (every leaf resolves []), so a wrong method name fails here as it would in the app.
vi.mock("../../api", async () => {
  const actual = await vi.importActual("../../api");
  const mockDeep = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [
    k, typeof v === "function" ? vi.fn().mockResolvedValue([]) : (v && typeof v === "object") ? mockDeep(v) : v,
  ]));
  return { ...actual, api: mockDeep(actual.api) };
});

import { CostLineForm } from "./ShipmentDetailPage";

// The office split (ARCHITECTURE.md §8.52): once a shipment's payment terms are saved, a line's Prepaid/Collect is its
// category's term — the form shows it and the server sets it the same way.
const fob = { id: "SHP-SPLIT1", incoterm: "FOB", emoOfficeId: "OFF-RTM", imoOfficeId: "OFF-NYC" };

describe("Cost line form: the Carrier Payment Indicator", () => {
  it("on a split FOB shipment it follows the category: Ocean freight Collect, Origin THC Prepaid, read-only", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CostLineForm shipment={{ ...fob, paymentTerms: { followsIncoterm: true } }} lockType="SELL" onSave={onSave} onSaveAndMirror={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId("costline-cpi")).toBeDisabled();
    expect(screen.getByTestId("costline-cpi")).toHaveValue("Collect");
    expect(screen.getByTestId("costline-cpi-follows")).toHaveTextContent("Ocean freight: Collect");
    fireEvent.change(screen.getByDisplayValue("Ocean Freight"), { target: { value: "Origin THC" } });
    expect(screen.getByTestId("costline-cpi")).toHaveValue("Prepaid");
    expect(screen.getByTestId("costline-cpi-follows")).toHaveTextContent("Origin port charges: Prepaid");
    fireEvent.change(screen.getByPlaceholderText(/0\.00|amount/i), { target: { value: "245" } });
    fireEvent.click(screen.getByText("Add Line"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ chargeCode: "Origin THC", paymentIndicator: "Prepaid" });
  });

  it("before the split it is chosen by hand", () => {
    render(<CostLineForm shipment={{ ...fob, paymentTerms: null }} lockType="BUY" onSave={vi.fn()} onSaveAndMirror={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId("costline-cpi")).not.toBeDisabled();
    expect(screen.getByTestId("costline-cpi")).toHaveValue("Prepaid");
    expect(screen.queryByTestId("costline-cpi-follows")).toBeNull();
  });
});
