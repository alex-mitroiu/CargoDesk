import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Mirrors the real src/api.js name: api.contracts.match (GET /api/contracts/match).
const match = vi.fn();
vi.mock("../api", () => ({ api: { contracts: { match: (...a) => match(...a) } } }));

import useContractMismatch from "./useContractMismatch";

// Since 2026-09-30 every contract leg sits on a routing line, so every match result carries a
// routing id. SHP-WIRHFD looped forever: picked through a space configuration, it was saved with
// a blank routing, and '' never equalled the result's CRTG-… id, so the forcing modal came back
// after every pick.
const SEA = [{ legType: "SEA", pol: "NLRTM", pod: "USNYC" }];
const ship = over => ({ id: "SHP-X", contractType: "Central", contractId: "CNTR-QA1TYG", contractRoutingId: "", etd: "2026-10-19", ...over });
const run = shipment => renderHook(() => useContractMismatch(shipment, "NLRTM", "USNYC", SEA));

beforeEach(() => match.mockReset());

describe("useContractMismatch", () => {
  it("a blank stored routing is 'not recorded': the contract matching on any line is enough", async () => {
    match.mockResolvedValue([{ id: "CNTR-QA1TYG", routingId: "CRTG-ZPOFBC" }]);
    const { result } = run(ship());
    await waitFor(() => expect(match).toHaveBeenCalled());
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("a recorded routing must itself still match", async () => {
    match.mockResolvedValue([{ id: "CNTR-QA1TYG", routingId: "CRTG-OTHER" }]);
    const { result } = run(ship({ contractRoutingId: "CRTG-ZPOFBC" }));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("a recorded routing that matches is fine", async () => {
    match.mockResolvedValue([{ id: "CNTR-QA1TYG", routingId: "CRTG-OTHER" }, { id: "CNTR-QA1TYG", routingId: "CRTG-ZPOFBC" }]);
    const { result } = run(ship({ contractRoutingId: "CRTG-ZPOFBC" }));
    await waitFor(() => expect(match).toHaveBeenCalled());
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("a contract that no longer covers the route is a mismatch, blank routing or not", async () => {
    match.mockResolvedValue([{ id: "CNTR-SOMEONE-ELSE", routingId: "CRTG-1" }]);
    const { result } = run(ship());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("asks with the SEA-leg ports and the ETD as the date", async () => {
    match.mockResolvedValue([]);
    run(ship());
    await waitFor(() => expect(match).toHaveBeenCalledWith({ pol: "NLRTM", pod: "USNYC", crd: "2026-10-19" }));
  });
});
