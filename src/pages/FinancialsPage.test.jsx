import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// The Financials hub: a card per page the caller was told the person may see, each with its own live count,
// each a direct way in. WHO may see which page is decided in App.jsx (src/utils/financialsNav.js) and handed in
// as `pages`, so this page only has to honour the list it is given.
//
// The api mock names are the REAL ones from src/api.js (a mock of an invented name once let unit tests pass
// while a real page came up empty — see the Space Configurations tests).
vi.mock("../api", () => ({
  api: {
    quotes: { list: vi.fn(() => Promise.resolve({ results: [{}], total: 169 })) },
    opportunities: { list: vi.fn(() => Promise.resolve({ results: [{}], total: 39 })) },
    carrierInvoices: { exceptions: vi.fn(() => Promise.resolve([{ id: "L1" }])) },
    creditOverridesQueue: vi.fn(() => Promise.resolve(new Array(8).fill({}))),
  },
}));

import FinancialsPage from "./FinancialsPage";
import { api } from "../api";

const ALL = ["quotes", "opportunities", "reports", "freight-audit", "credit-overrides"];
const cardKeys = () => screen.getAllByTestId(/^financials-card-/).map(c => c.getAttribute("data-testid").replace("financials-card-", ""));

beforeEach(() => { vi.clearAllMocks(); });

describe("Financials hub", () => {
  it("shows a card for each page it is given, in the order given", () => {
    render(<FinancialsPage pages={ALL} navigate={() => {}} />);
    expect(screen.getByRole("heading", { name: "Financials" })).toBeInTheDocument();
    expect(cardKeys()).toEqual(ALL);
    for (const title of ["Quotes", "Opportunities", "Reports", "Freight Audit", "Credit Overrides"]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });

  it("shows only the cards for the pages it is given", () => {
    render(<FinancialsPage pages={["quotes", "opportunities", "freight-audit"]} navigate={() => {}} />);
    expect(cardKeys()).toEqual(["quotes", "opportunities", "freight-audit"]);
    expect(screen.queryByTestId("financials-card-credit-overrides")).toBeNull();
    expect(screen.queryByTestId("financials-card-reports")).toBeNull();
  });

  it("fills in each page's own figure, singular or plural", async () => {
    render(<FinancialsPage pages={ALL} navigate={() => {}} />);
    const text = key => screen.getByTestId(`financials-count-${key}`).textContent;     // exact: "1open exception" must not match "1open exceptions"
    await waitFor(() => expect(screen.getByTestId("financials-count-quotes")).toBeInTheDocument());
    expect(text("quotes")).toBe("169quotes");
    expect(text("opportunities")).toBe("39opportunities");
    expect(text("freight-audit")).toBe("1open exception");                              // one → singular
    expect(text("credit-overrides")).toBe("8blocked shipments");
    expect(screen.queryByTestId("financials-count-reports")).toBeNull();                                    // Reports has no count
  });

  it("only fetches the figures of the cards it shows", async () => {
    render(<FinancialsPage pages={["quotes", "opportunities", "freight-audit"]} navigate={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("financials-count-quotes")).toBeInTheDocument());
    expect(api.creditOverridesQueue).not.toHaveBeenCalled();
  });

  it("leaves a card without a number, but still there, when its figure fails to load", async () => {
    api.quotes.list.mockImplementationOnce(() => Promise.reject(new Error("down")));
    api.creditOverridesQueue.mockImplementationOnce(() => { throw new Error("threw before returning a promise"); });
    render(<FinancialsPage pages={ALL} navigate={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("financials-count-opportunities")).toBeInTheDocument());
    expect(cardKeys()).toEqual(ALL);
    expect(screen.queryByTestId("financials-count-quotes")).toBeNull();
    expect(screen.queryByTestId("financials-count-credit-overrides")).toBeNull();
  });

  it("opens the page behind a card, by click or by keyboard", () => {
    const navigate = vi.fn();
    render(<FinancialsPage pages={ALL} navigate={navigate} />);
    fireEvent.click(screen.getByTestId("financials-card-reports"));
    expect(navigate).toHaveBeenLastCalledWith("reports");
    fireEvent.keyDown(screen.getByTestId("financials-card-credit-overrides"), { key: "Enter" });
    expect(navigate).toHaveBeenLastCalledWith("credit-overrides");
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("ignores a page key it has no card for", () => {
    render(<FinancialsPage pages={["quotes", "not-a-page"]} navigate={() => {}} />);
    expect(cardKeys()).toEqual(["quotes"]);
  });
});
