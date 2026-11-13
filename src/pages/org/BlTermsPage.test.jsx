import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// Mirror the REAL api.js's shape (every leaf resolves []), so a wrong method name fails here as it would in the app.
vi.mock("../../api", async () => {
  const actual = await vi.importActual("../../api");
  const mockDeep = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [
    k, typeof v === "function" ? vi.fn().mockResolvedValue([]) : (v && typeof v === "object") ? mockDeep(v) : v,
  ]));
  return { ...actual, api: mockDeep(actual.api) };
});

import BlTermsPage from "./BlTermsPage";
import { api } from "../../api";
import { AuthContext } from "../../AuthContext";

// GET /api/bl-terms, as lib/bl-terms.js list() returns it: the organisation's English starter text, Rotterdam Branch
// with English and Dutch (Dutch with its PDF, and the default of NL-NLRTM-SE), New York Branch with none.
const doc = over => ({ id: "BLT-X", key: "BRANCH:en", owner: "BRANCH", branchId: "BRN-79E27Q", ownerName: "Rotterdam Branch", language: "en",
  languageName: "English", version: 2, title: "Terms and Conditions of the House Bill of Lading", chars: 120, hasPdf: false, pdfFilename: "", pdfPages: 0,
  isStarter: false, createdAt: "2026-11-10T09:00:00.000Z", createdBy: "Admin", retired: false, text: "1. Definitions\n“Carrier” means …", ...over });
const LIST = {
  maxTextLength: 50000, maxPdfBytes: 10485760,
  sets: [
    { branchId: null, name: "Organisation default", code: "", countryCode: "", scac: "", isActive: true, defaultFor: [],
      docs: [doc({ id: "BLT-ORG-EN", key: "ORG:en", owner: "ORG", branchId: null, ownerName: "Organisation default", version: 1, isStarter: true, createdBy: "CargoDesk" })],
      versions: [{ id: "BLT-ORG-EN", language: "en", languageName: "English", version: 1, createdAt: "2026-11-10T08:00:00.000Z", createdBy: "CargoDesk", isStarter: true, retired: false, pdfFilename: "", issuedCount: 0 }] },
    { branchId: "BRN-79E27Q", name: "Rotterdam Branch", code: "RTM", countryCode: "NL", scac: "CDHB", isActive: true,
      defaultFor: [{ code: "NL-NLRTM-SE", name: "Rotterdam Office", key: "BRANCH:nl" }],
      docs: [doc({ id: "BLT-RTM-EN" }), doc({ id: "BLT-RTM-NL", key: "BRANCH:nl", language: "nl", languageName: "Dutch", hasPdf: true,
        pdfFilename: "RTM-cognossementsvoorwaarden-2026.pdf", pdfPages: 2, text: "1. Definities\n“Vervoerder” is …" })],
      versions: [
        { id: "BLT-RTM-NL", language: "nl", languageName: "Dutch", version: 2, createdAt: "2026-11-10T09:00:00.000Z", createdBy: "Admin", isStarter: false, retired: false, pdfFilename: "RTM-cognossementsvoorwaarden-2026.pdf", issuedCount: 0 },
        { id: "BLT-RTM-NL-1", language: "nl", languageName: "Dutch", version: 1, createdAt: "2026-03-01T09:00:00.000Z", createdBy: "Admin", isStarter: false, retired: false, pdfFilename: "RTM-voorwaarden-2025.pdf", issuedCount: 41 },
      ] },
    { branchId: "BRN-JUPA5H", name: "New York Branch", code: "NYC", countryCode: "US", scac: "", isActive: true, defaultFor: [], docs: [], versions: [] },
  ],
};

const renderPage = (auth = { isAdmin: true }) => render(<AuthContext.Provider value={auth}><BlTermsPage /></AuthContext.Provider>);

beforeEach(() => { vi.clearAllMocks(); api.blTerms.list.mockResolvedValue(LIST); });

describe("Organisation → B/L Terms", () => {
  it("is for admins only", () => {
    renderPage({ isAdmin: false });
    expect(screen.getByText("B/L terms are kept by admins.")).toBeInTheDocument();
    expect(api.blTerms.list).not.toHaveBeenCalled();
  });

  it("opens on the organisation's English starter text, marked as such, which can't be removed", async () => {
    renderPage();
    expect(await screen.findByTestId("bl-terms-starter")).toHaveTextContent("Starter text.");
    expect(screen.getByTestId("bl-terms-text")).toHaveValue("1. Definitions\n“Carrier” means …");
    expect(screen.queryByTestId("bl-terms-retire")).toBeNull();
    // New York Branch has none: it isn't listed until chosen, and is offered under "Terms for another entity".
    const sets = screen.getByTestId("bl-terms-sets");
    expect(within(sets).queryByText("New York Branch")).toBeNull();
    expect(within(sets).getByRole("option", { name: "NYC — New York Branch" })).toBeInTheDocument();
  });

  it("an entity's Dutch terms: the PDF, the office that defaults to them, the versions; saving sends a new version", async () => {
    api.blTerms.save.mockResolvedValue({ doc: { version: 3 } });
    renderPage();
    fireEvent.click(await screen.findByTestId("bl-terms-set-BRN-79E27Q"));
    fireEvent.click(screen.getByTestId("bl-terms-lang-nl"));
    expect(screen.getByText("Default terms of NL-NLRTM-SE (Dutch)")).toBeInTheDocument();
    expect(screen.getByTestId("bl-terms-pdf-current")).toHaveTextContent("RTM-cognossementsvoorwaarden-2026.pdf · 2 pages");
    expect(screen.getByText("41 House B/Ls")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("bl-terms-text"), { target: { value: "1. Definities\n“Vervoerder” is de vennootschap …" } });
    fireEvent.click(screen.getByTestId("bl-terms-save"));
    await waitFor(() => expect(api.blTerms.save).toHaveBeenCalledWith({ branchId: "BRN-79E27Q", language: "nl", title: "Terms and Conditions of the House Bill of Lading",
      text: "1. Definities\n“Vervoerder” is de vennootschap …", keepPdf: true }));
    expect(api.blTerms.list).toHaveBeenCalledTimes(2);
  });

  it("adding German: a blank editor; without text it isn't saved", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("bl-terms-set-BRN-79E27Q"));
    fireEvent.change(screen.getByTestId("bl-terms-add-language"), { target: { value: "de" } });
    expect(screen.getByTestId("bl-terms-text")).toHaveValue("");
    expect(screen.getByText(/German terms for Rotterdam Branch/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("bl-terms-save"));
    expect(api.blTerms.save).not.toHaveBeenCalled();
  });

  it("stopping a language takes a second click, after naming the offices that start with it", async () => {
    api.blTerms.retire.mockResolvedValue({ retired: 2, clearedOffices: [{ id: "OFF-1", code: "NL-NLRTM-SE", name: "Rotterdam Office" }] });
    renderPage();
    fireEvent.click(await screen.findByTestId("bl-terms-set-BRN-79E27Q"));
    fireEvent.click(screen.getByTestId("bl-terms-lang-nl"));
    fireEvent.click(screen.getByTestId("bl-terms-retire"));
    expect(api.blTerms.retire).not.toHaveBeenCalled();
    expect(screen.getByTestId("bl-terms-retire")).toHaveTextContent("Click again: stop offering Dutch");
    // The pre-release audit, C3: the office that starts with Dutch is named before, moved to English after.
    expect(screen.getByTestId("bl-terms-retire-note")).toHaveTextContent("NL-NLRTM-SE starts House B/Ls with these terms: once they're no longer offered, it starts with English.");
    fireEvent.click(screen.getByTestId("bl-terms-retire"));
    await waitFor(() => expect(api.blTerms.retire).toHaveBeenCalledWith("BRN-79E27Q", "nl"));
  });
});
