import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// Mirror the REAL api.js's shape (every leaf resolves []), so a wrong method name fails here as it
// would in the app — same approach as ShipmentHeaderBar.test.jsx.
vi.mock("../../api", async () => {
  const actual = await vi.importActual("../../api");
  const mockDeep = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [
    k, typeof v === "function" ? vi.fn().mockResolvedValue([]) : (v && typeof v === "object") ? mockDeep(v) : v,
  ]));
  return { ...actual, api: mockDeep(actual.api) };
});
// The PDF's HTML is built from many lookups; the panel only needs what it hands to the server.
vi.mock("../../utils/houseBlDocument", async () => {
  const actual = await vi.importActual("../../utils/houseBlDocument");
  return { ...actual, buildHouseBlHtml: vi.fn(async (s, { docNum, docDate, statement }) =>
    ({ html: "<html>BL</html>", filename: `BL01-${docNum}-${docDate}.pdf`, houseBl: statement })) };
});

import HouseBlPanel, { fixPlaceOf, stageOf, eventText } from "./HouseBlPanel";
import { api } from "../../api";
import { buildHouseBlHtml } from "../../utils/houseBlDocument";
import { AuthContext } from "../../AuthContext";

const shipment = { id: "SHP-T1", shipperName: "Acme Freight B.V.", consigneeName: "Empire Logistics Partners (Brooklyn) Inc", podName: "New York", pod: "USNYC",
  blReleaseType: "Original", blNumber: "", freightTerms: "Prepaid" };
const summary = (over = {}) => ({
  documents: [], live: null, draft: null, amends: null, changedSinceIssue: null, charges: [], routing: null,
  handoverMethods: ["In person", "Courier", "Mail"],
  readiness: { ready: true, missing: [], number: { value: null, source: "SERIES", next: "RTMHBL2600018", officeName: "Rotterdam Office" } }, release: null,
  onBoard: { shippedOnBoard: true, onBoardDate: "2026-10-21", onBoardSource: "Loaded event", receivedDate: null },
  packageCodes: [], issuer: { officeName: "Rotterdam Office", unlocode: "NLRTM", placeName: "Rotterdam", entityName: "Rotterdam Branch", scac: "" },
  ebl: { available: true, platforms: ["WAVE", "CARX"], entityName: "Rotterdam Branch", entityGaps: [], shipperPlatformIds: [] },
  ...over,
});
const issued = (over = {}) => ({ id: "TD-1", status: "ISSUED", reference: "RTMHBL2600018", typeCode: "BOL", releaseType: "Original", isElectronic: false,
  isShippedOnBoardType: true, shippedOnBoardDate: "2026-10-21", issueDate: "2026-10-21", placeOfIssue: "NLRTM", documentId: "DOC-1",
  hasPayload: true, payloadErrors: "", releasedAt: null, eblIssuanceStatus: "", version: 1, numberSource: "SERIES", originals: 3, copies: 0, withCharges: false,
  toOrderMode: "", ...over });

const renderPanel = (s, auth = {}, { events = [], ship = shipment } = {}) => {
  api.houseBl.get.mockResolvedValue(s);
  api.houseBl.events.mockResolvedValue(events);
  return render(
    <AuthContext.Provider value={{ isAdmin: true, user: { name: "Dana", canViewFinance: false }, ...auth }}>
      <HouseBlPanel shipment={ship} canEdit docs={[]} onChanged={() => {}} />
    </AuthContext.Provider>,
  );
};

beforeEach(() => vi.clearAllMocks());

describe("HouseBlPanel", () => {
  it("lists what blocks issue, each with where to fix it, and keeps Issue off", async () => {
    renderPanel(summary({ readiness: { ready: false, missing: [
      "A carrier booking confirmed by the carrier, with its booking number",
      "Release type (Conditions page)",
      "Container HLCU123456: number of packages, kind of packages, HS code (6–10 digits)",
    ] } }));
    const list = await screen.findByTestId("house-bl-readiness");
    expect(within(list).getByRole("link", { name: "Carrier Booking" })).toHaveAttribute("href", "#shipments/SHP-T1/booking/details");
    expect(within(list).getByRole("link", { name: "Conditions" })).toHaveAttribute("href", "#shipments/SHP-T1/conditions");
    expect(within(list).getByRole("link", { name: "Cargo" })).toHaveAttribute("href", "#shipments/SHP-T1/containers");
    expect(screen.getByTestId("house-bl-issue")).toBeDisabled();
    expect(screen.getByTestId("house-bl-status")).toHaveTextContent("NONE YET");
  });

  it("issues a ready House B/L: takes the series number, builds it dated today with what it says, then confirms it", async () => {
    api.houseBl.number.mockResolvedValue({ number: "RTMHBL2600018", source: "SERIES", assigned: true });
    api.documents.generate.mockResolvedValue({ id: "DOC-NEW" });
    api.documents.patch.mockResolvedValue({ id: "DOC-NEW", status: "confirmed" });
    renderPanel(summary());
    expect(await screen.findByTestId("house-bl-ready")).toBeInTheDocument();
    expect(screen.getByTestId("house-bl-number")).toHaveTextContent("RTMHBL2600018 (next)");
    expect(screen.getByTestId("house-bl-number")).toHaveTextContent("Taken from the Rotterdam Office series when you press Issue");
    fireEvent.click(screen.getByTestId("house-bl-issue"));
    await waitFor(() => expect(api.documents.patch).toHaveBeenCalledWith("SHP-T1", "DOC-NEW", { status: "confirmed" }));
    expect(api.houseBl.number).toHaveBeenCalledWith("SHP-T1");
    const [, opts] = buildHouseBlHtml.mock.calls[0];
    expect(opts.docNum).toBe("RTMHBL2600018");
    const said = { shippedOnBoard: true, onBoardDate: "2026-10-21", originals: 3, copies: 0, withCharges: false };
    expect(opts.statement).toEqual(said);
    expect(opts.docDate).toBe(new Date().toISOString().slice(0, 10));
    expect(opts.signatory).toBe("Dana");
    expect(api.documents.generate).toHaveBeenCalledWith("SHP-T1", expect.objectContaining({ docType: "BL01", houseBl: said }));
  });

  it("a draft before issue takes no number; originals, copies and the charges go with what it says", async () => {
    api.documents.generate.mockResolvedValue({ id: "DOC-D" });
    renderPanel(summary({ charges: [{ code: "OFR", name: "Ocean freight", currency: "USD", amount: 2450, paymentTerm: "PRE" }] }));
    await screen.findByTestId("house-bl-ready");
    fireEvent.change(screen.getByTestId("house-bl-originals"), { target: { value: "2" } });
    fireEvent.change(screen.getByTestId("house-bl-copies"), { target: { value: "4" } });
    expect(screen.getByTestId("house-bl-freight-charges").closest("label")).toHaveTextContent("the shipment's 1 selling charge");
    fireEvent.click(screen.getByTestId("house-bl-freight-charges"));
    fireEvent.click(screen.getByTestId("house-bl-generate-draft"));
    await waitFor(() => expect(api.documents.generate).toHaveBeenCalled());
    expect(api.houseBl.number).not.toHaveBeenCalled();
    const [, opts] = buildHouseBlHtml.mock.calls[0];
    expect(opts.docNum).toBe("");
    expect(opts.statement).toEqual({ shippedOnBoard: true, onBoardDate: "2026-10-21", originals: 2, copies: 4, withCharges: true });
    fireEvent.change(screen.getByTestId("house-bl-originals"), { target: { value: "0" } });
    expect(screen.getByTestId("house-bl-issue")).toBeDisabled();
  });

  it("a Sea Waybill has no originals to choose", async () => {
    renderPanel(summary(), {}, { ship: { ...shipment, blReleaseType: "Seaway Bill" } });
    const originals = await screen.findByTestId("house-bl-originals");
    expect(originals).toBeDisabled();
    expect(originals).toHaveValue(0);
  });

  it("before loading, a Received for shipment copy can be issued: the loading item goes away", async () => {
    renderPanel(summary({ onBoard: { shippedOnBoard: false }, readiness: { ready: false, missing: [
      "Loading: the draft says Shipped on board, but no Loaded or Sailed event is recorded. Record it, or issue a Received for shipment draft"] } }));
    expect(await screen.findByTestId("house-bl-ready")).toBeInTheDocument();
    expect(screen.getByTestId("house-bl-statement-received")).toBeChecked();
    expect(screen.getByTestId("house-bl-issue")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("house-bl-statement-onboard"));
    expect(screen.getByTestId("house-bl-issue")).toBeDisabled();
    fireEvent.change(screen.getByTestId("house-bl-onboard-date"), { target: { value: "2026-10-20" } });
    expect(screen.getByTestId("house-bl-issue")).not.toBeDisabled();
  });

  it("an issued Original B/L: originals presented at destination, then release with the finance override", async () => {
    api.documents.blRelease.mockResolvedValue({});
    renderPanel(summary({ live: issued(), readiness: null, release: { blocks: [{ key: "collect_charges", message: "Collect charges aren't paid: OFR (not invoiced)" }] } }));
    expect(await screen.findByTestId("house-bl-status")).toHaveTextContent("ISSUED");
    expect(screen.getByTestId("house-bl-surrender")).toHaveTextContent("Originals presented at destination");
    fireEvent.change(screen.getByLabelText(/Presented by/), { target: { value: "Atlantic Trade Bank NA" } });
    fireEvent.click(screen.getByTestId("house-bl-surrender"));
    await waitFor(() => expect(api.documents.blSurrender).toHaveBeenCalledWith("SHP-T1", "DOC-1", { presentedBy: "Atlantic Trade Bank NA" }));
    fireEvent.click(screen.getByTestId("house-bl-open-release"));
    const modal = await screen.findByTestId("house-bl-release-modal");
    expect(within(modal).getByTestId("house-bl-release-check-collect_charges")).toHaveTextContent("BLOCKS");
    expect(within(modal).getByTestId("house-bl-release-check-collect_charges")).toHaveTextContent("OFR (not invoiced)");
    expect(within(modal).getByTestId("house-bl-release-check-credit_hold")).toHaveTextContent("OK");
    expect(within(modal).getByTestId("house-bl-release-confirm")).toBeDisabled();
    expect(within(modal).getByTestId("house-bl-release-override")).toBeDisabled();
    fireEvent.change(within(modal).getByLabelText("Reason"), { target: { value: "Paid by wire" } });
    fireEvent.click(within(modal).getByTestId("house-bl-release-override"));
    await waitFor(() => expect(api.documents.blRelease).toHaveBeenCalledWith("SHP-T1", "DOC-1", { override: true, overrideReason: "Paid by wire" }));
  });

  it("without admin or finance access there is no override", async () => {
    renderPanel(summary({ live: issued(), readiness: null, release: { blocks: [{ key: "credit_hold", message: "Hudson is on credit hold" }] } }),
      { isAdmin: false, user: { name: "Op", canViewFinance: false } });
    fireEvent.click(await screen.findByTestId("house-bl-open-release"));
    const modal = await screen.findByTestId("house-bl-release-modal");
    expect(within(modal).queryByTestId("house-bl-release-override")).toBeNull();
    expect(modal).toHaveTextContent("An admin or a user with finance access can override these checks.");
  });

  it("issues it as an eBL to WAVE, using the shipper's WAVE id", async () => {
    api.houseBl.issueEbl.mockResolvedValue({});
    renderPanel(summary({ live: issued(), readiness: null, release: { blocks: [] },
      ebl: { available: true, platforms: ["WAVE", "CARX"], entityName: "Rotterdam Branch", entityGaps: [], shipperPlatformIds: [{ platform: "WAVE", code: "WAVE-ACME-1" }] } }));
    fireEvent.click(await screen.findByTestId("house-bl-ebl-open"));
    expect(screen.getByTestId("house-bl-ebl-box")).toHaveTextContent("WAVE-ACME-1");
    fireEvent.click(screen.getByTestId("house-bl-ebl-send"));
    await waitFor(() => expect(api.houseBl.issueEbl).toHaveBeenCalledWith("SHP-T1", { platform: "WAVE" }));
  });

  it("logs the originals handed over, and a new handover", async () => {
    api.houseBl.originalsHandover.mockResolvedValue({});
    renderPanel(summary({ live: issued(), readiness: null, release: { blocks: [] } }), {}, { events: [
      { id: "E1", eventType: "ISSUED", detail: { shippedOnBoard: true, date: "2026-10-21", originals: 3, copies: 0 }, createdAt: "2026-10-21T10:00:00Z" },
      { id: "E2", eventType: "ORIGINALS_HANDED_OVER", detail: { to: "Acme Freight B.V.", method: "Courier", trackingRef: "DHL 4471 9920 31", count: 3, total: 3, on: "2026-10-22" },
        createdAt: "2026-10-22T09:00:00Z" },
    ] });
    const log = await screen.findByTestId("house-bl-originals-log");
    await waitFor(() => expect(log).toHaveTextContent("3 of 3 by courier to Acme Freight B.V."));
    expect(log).toHaveTextContent("DHL 4471 9920 31");
    fireEvent.click(screen.getByTestId("house-bl-handover-open"));
    expect(screen.getByLabelText("To")).toHaveValue("Acme Freight B.V.");
    expect(screen.getByTestId("house-bl-handover-save")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Tracking number"), { target: { value: "1Z999AA10123456784" } });
    fireEvent.change(screen.getByLabelText("Originals"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("house-bl-handover-save"));
    await waitFor(() => expect(api.houseBl.originalsHandover).toHaveBeenCalledWith("SHP-T1", expect.objectContaining({
      to: "Acme Freight B.V.", method: "Courier", trackingRef: "1Z999AA10123456784", count: 2 })));
  });

  it("says what changed since issue, and surrenders it for amendment with a reason", async () => {
    api.houseBl.surrenderForAmendment.mockResolvedValue({});
    renderPanel(summary({ live: issued(), readiness: null, release: { blocks: [] }, changedSinceIssue: ["Consignee"] }));
    expect(await screen.findByTestId("house-bl-changed")).toHaveTextContent("Changed since issue: Consignee");
    expect(screen.getByTestId("house-bl-changed")).toHaveTextContent("issue version 2 under the same number");
    fireEvent.click(screen.getByTestId("house-bl-amend"));
    const form = screen.getByTestId("house-bl-amend-form");
    expect(within(form).getByTestId("house-bl-amend-confirm")).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "Consignee moved to 1 Harbor Gateway" } });
    fireEvent.click(within(form).getByTestId("house-bl-amend-confirm"));
    await waitFor(() => expect(api.houseBl.surrenderForAmendment).toHaveBeenCalledWith("SHP-T1", "Consignee moved to 1 Harbor Gateway"));
  });

  it("after a surrender for amendment, the next issue is version 2 under the same number", async () => {
    const v1 = issued({ status: "SURRENDERED_FOR_AMENDMENT", surrenderedAt: "2026-10-22T10:00:00Z", amendmentReason: "Consignee moved", copies: 2, withCharges: true });
    renderPanel(summary({ amends: v1, documents: [v1],
      readiness: { ready: true, missing: [], number: { value: "RTMHBL2600018", source: "SERIES", officeName: "Rotterdam Office" } } }));
    expect(await screen.findByTestId("house-bl-amending")).toHaveTextContent("Version 2 replaces version 1");
    expect(screen.getByTestId("house-bl-amending")).toHaveTextContent("Consignee moved");
    expect(screen.getByTestId("house-bl-status")).toHaveTextContent("AMENDING · v2");
    expect(screen.getByTestId("house-bl-number")).toHaveTextContent("Kept from version 1");
    expect(screen.getByTestId("house-bl-issue")).toHaveTextContent("Issue version 2");
    // Version 1's originals, copies and charges carry over; the versions box lists both.
    expect(screen.getByTestId("house-bl-copies")).toHaveValue(2);
    expect(screen.getByTestId("house-bl-freight-charges")).toBeChecked();
    expect(screen.getByTestId("house-bl-versions")).toHaveTextContent("v1");
    expect(screen.getByTestId("house-bl-versions")).toHaveTextContent("v2 Not issued yet");
  });

  it("after a surrender at origin, says the import office got the telex release notice", async () => {
    renderPanel(summary({ live: issued({ status: "SURRENDERED_FOR_DELIVERY", surrenderKind: "origin", releaseType: "Telex Release" }), readiness: null, release: { blocks: [] } }),
      {}, { events: [{ id: "E3", eventType: "TELEX_RELEASE_NOTICE", detail: { office: "New York Harbor", ticketId: "TKT-ABC123", sent: true }, createdAt: "2026-10-22T11:00:00Z" }] });
    const notice = await screen.findByTestId("house-bl-telex-notice");
    expect(notice).toHaveTextContent("Telex release notice sent to New York Harbor");
    expect(notice).toHaveTextContent("TKT-ABC123");
    expect(within(notice).getByRole("link", { name: "Integration Board" })).toHaveAttribute("href", "#kanban");
  });

  it("says what the legal entity still needs before an eBL", async () => {
    renderPanel(summary({ live: issued(), readiness: null, release: { blocks: [] },
      ebl: { available: true, platforms: ["WAVE"], entityName: "Rotterdam Branch", entityGaps: ["a SCAC", "a phone or email"], shipperPlatformIds: [] } }));
    fireEvent.click(await screen.findByTestId("house-bl-ebl-open"));
    expect(screen.getByTestId("house-bl-entity-gaps")).toHaveTextContent("Rotterdam Branch needs a SCAC, a phone or email");
  });
});

describe("House B/L panel helpers", () => {
  it("sends each readiness item to where it's fixed", () => {
    expect(fixPlaceOf("Shipper's address: street, city and country on Acme (Customers)", "S1")).toEqual({ label: "Customers", href: "#mdm-customers" });
    expect(fixPlaceOf("Notify party (Parties & Offices)", "S1").href).toBe("#shipments/S1/parties");
    expect(fixPlaceOf("Vessel and voyage", "S1").href).toBe("#shipments/S1/schedules");
    expect(fixPlaceOf("The AES/EEI export filing accepted, with its ITN (Customs Filing)", "S1").href).toBe("#shipments/S1/customs-filing/details");
    expect(fixPlaceOf("Loading: the draft says Shipped on board", "S1").href).toBe("#shipments/S1/milestones");
    expect(fixPlaceOf("A Sea Waybill can't be issued to order: choose a named consignee, or another release type (Conditions)", "S1").href).toBe("#shipments/S1/conditions");
    expect(fixPlaceOf("Container MSKU1647203: UN number (dangerous goods), proper shipping name (dangerous goods)", "S1").href).toBe("#shipments/S1/containers");
  });
  it("places a House B/L on the progress line", () => {
    expect(stageOf(null)).toBe(0);
    expect(stageOf({ status: "DRAFT" })).toBe(0);
    expect(stageOf({ status: "ISSUED" })).toBe(1);
    expect(stageOf({ status: "SURRENDERED_FOR_DELIVERY" })).toBe(2);
    expect(stageOf({ status: "SURRENDERED_FOR_DELIVERY", releasedAt: "2026-10-22" })).toBe(3);
  });
  it("words the history", () => {
    expect(eventText({ eventType: "EBL_ISSUED", detail: { platform: "WAVE" } })).toBe("WAVE issued the eBL (ISSU)");
    expect(eventText({ eventType: "RELEASED_WITH_OVERRIDE", detail: { reason: "Paid by wire" } })).toBe("Released with an override: Paid by wire");
    expect(eventText({ eventType: "SURRENDERED_FOR_DELIVERY", detail: { kind: "destination" } })).toBe("Originals presented at destination");
    expect(eventText({ eventType: "SURRENDERED_FOR_DELIVERY", detail: { kind: "destination", presentedBy: "Atlantic Trade Bank NA" } })).toBe("Originals presented at destination by Atlantic Trade Bank NA");
    expect(eventText({ eventType: "ISSUED", detail: { version: 2, shippedOnBoard: true, date: "2026-10-22", originals: 3, copies: 2 } }))
      .toBe("Version 2 issued, shipped on board 22 Oct 2026 · 3 originals, 2 copies");
    expect(eventText({ eventType: "SURRENDERED_FOR_AMENDMENT", detail: { reason: "Consignee moved" } })).toBe("Surrendered for amendment: Consignee moved");
    expect(eventText({ eventType: "ORIGINALS_HANDED_OVER", detail: { to: "Acme", method: "In person", count: 3, total: 3 } })).toBe("Originals handed over: 3 of 3 in person to Acme");
    expect(eventText({ eventType: "TELEX_RELEASE_NOTICE", detail: { sent: false } })).toBe("Telex release: no import office on the shipment, nobody was told");
  });
});
