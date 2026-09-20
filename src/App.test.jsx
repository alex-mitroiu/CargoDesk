import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import App from "./App";

// App.jsx talks to the backend exclusively through ./api, across dozens of namespaces (auth,
// shipments, offices, systemMessages, ...) — App itself only uses a handful during boot, but
// LoginPage and other always-mounted children call their own (api.auth.ssoConfig, etc.), and
// enumerating every one by hand is exactly the kind of list that silently rots as the app
// grows. Instead, mirror the REAL api.js's shape (via importActual) and auto-wrap every leaf
// function in a vi.fn() that resolves an empty array by default — a safe default for the
// .list()-shaped majority, and harmless for the handful of single-object calls (LoginPage's
// `.then(({ enabled }) => ...)` destructuring off `[]` just yields undefined, not a crash).
// Tests override specific methods (api.auth.me, etc.) with mockResolvedValueOnce as needed.
vi.mock("./api", async () => {
  const actual = await vi.importActual("./api");
  const mockDeep = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [
    k,
    typeof v === "function" ? vi.fn().mockResolvedValue([])
      : (v && typeof v === "object") ? mockDeep(v)
      : v,
  ]));
  return { ...actual, api: mockDeep(actual.api) };
});

import { api } from "./api";

describe("App — core shell / auth gating", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    window.location.hash = "";
  });

  it("renders the login page when no token is stored", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    // api.auth.me must never be called with no token to check — nothing to verify.
    expect(api.auth.me).not.toHaveBeenCalled();
  });

  it("clears a stale token and falls back to the login page when auth.me rejects", async () => {
    localStorage.setItem("cargodesk_token", "stale-token");
    api.auth.me.mockRejectedValueOnce(new Error("invalid token"));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(localStorage.getItem("cargodesk_token")).toBeNull();
  });

  it("renders the main app shell once a stored token resolves to a real user", async () => {
    localStorage.setItem("cargodesk_token", "valid-token");
    localStorage.setItem("cargodesk_license_accepted", "1");
    api.auth.me.mockResolvedValueOnce({
      id: "USR-1", name: "Test Admin", email: "admin@test.local",
      roles: ["admin"], allOffices: true, offices: [], passwordExpired: false,
    });

    render(<App />);

    // The Sign In screen must be gone and the nav shell (present on every authenticated page)
    // must be up — this is the actual "did the shell render" signal, not just "did *a* heading
    // appear," which the login screen would also satisfy.
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument());
    expect(await screen.findByText("Shipments")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  it("role switcher offers only this account's own assigned roles, not every role in the system", async () => {
    // Direct bug report: an admin account with exactly 2 assigned roles (Admin, OCC Booking —
    // confirmed via the real User Management table) saw all 5 system roles in the switcher.
    // Root cause was availableRoles() offering every role ranked at-or-below the user's own
    // primary rank (an "impersonate any lower role" shortcut) rather than the roles actually on
    // the account. Fixed to be strictly this account's own roles.
    localStorage.setItem("cargodesk_token", "valid-token");
    localStorage.setItem("cargodesk_license_accepted", "1");
    api.auth.me.mockResolvedValueOnce({
      id: "USR-1", name: "Test Admin", email: "admin@test.local",
      roles: ["admin", "occ_bk"], allOffices: true, offices: [], passwordExpired: false,
    });

    render(<App />);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument());
    await screen.findByText("Shipments");

    const roleSelect = screen.getByTitle("Roles: Admin, OCC Booking");
    const optionLabels = Array.from(roleSelect.querySelectorAll("option")).map(o => o.textContent);
    expect(optionLabels.sort()).toEqual(["Admin", "OCC Booking"].sort());
    expect(optionLabels).not.toContain("Operator");
    expect(optionLabels).not.toContain("Trade Manager");
    expect(optionLabels).not.toContain("Viewer");
  });
});

// ── The sidebar's Financials group ───────────────────────────────────────────────────────────────────────
// Quotes, Opportunities, Reports, Freight Audit and Credit Overrides live in one foldable Financials group
// (with a hub page), instead of being spread across the top level and the Dashboard group. These render the
// REAL shell as different people and read the real sidebar: what is top level, what is inside each group, and
// who sees what. The access rules themselves are unit-tested in utils/financialsNav.test.js; this proves the
// sidebar actually applies them.
describe("App — sidebar: the Financials group", () => {
  const signIn = (roles, extra = {}) => {
    localStorage.setItem("cargodesk_token", "valid-token");
    localStorage.setItem("cargodesk_license_accepted", "1");
    api.auth.me.mockResolvedValueOnce({
      id: "USR-1", name: "Test User", email: "u@test.local",
      roles, allOffices: true, offices: [], passwordExpired: false, ...extra,
    });
  };
  const navButtons = () => within(screen.getByTestId("main-nav")).getAllByRole("button")
    .map(b => ({ el: b, label: b.textContent.replace("▶", "").trim() }));
  const labels = () => navButtons().map(b => b.label);
  const bootAs = async (roles, extra) => {
    signIn(roles, extra);
    render(<App />);
    await screen.findByTestId("main-nav");
    await waitFor(() => expect(labels()).toContain("Shipments"));
  };
  // The fold arrow is a span titled Expand/Collapse inside its group's own button.
  const foldOf = label => navButtons().find(b => b.label === label).el.querySelector("span[title]");
  const openGroup = label => fireEvent.click(foldOf(label));
  // What sits between a group's own button and the next top-level item — read from the rendered order.
  const children = (label, nextTopLevel) => { const l = labels(); return l.slice(l.indexOf(label) + 1, l.indexOf(nextTopLevel)); };

  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); window.location.hash = ""; });

  it("has no Quotes, Reports, Freight Audit or Credit Overrides at the top level any more — just a Financials group", async () => {
    await bootAs(["admin"]);
    const l = labels();
    expect(l).toEqual(expect.arrayContaining(["Shipments", "Dashboard", "Financials", "Integration Board", "Schedule Search"]));
    for (const gone of ["Quotes", "Opportunities", "Reports", "Freight Audit", "Credit Overrides"]) expect(l).not.toContain(gone);
    // Financials follows Dashboard, ahead of the Integration Board
    expect(l.indexOf("Dashboard")).toBeLessThan(l.indexOf("Financials"));
    expect(l.indexOf("Financials")).toBeLessThan(l.indexOf("Integration Board"));
  });

  it("lists an admin's five pages in the agreed order once the group is opened — Opportunities beside Quotes, not under it", async () => {
    await bootAs(["admin"]);
    openGroup("Financials");
    expect(children("Financials", "Integration Board")).toEqual(["Quotes", "Opportunities", "Reports", "Freight Audit", "Credit Overrides"]);
    // "beside": the same indent as Quotes, not one level deeper
    const pad = label => navButtons().find(b => b.label === label).el.style.padding;
    expect(pad("Opportunities")).toBe(pad("Quotes"));
    expect(localStorage.getItem("cd_navfold_financials")).toBe("1");
  });

  it("gives each role only what it could already see", async () => {
    // viewer: the three open pages
    await bootAs(["viewer"]);
    openGroup("Financials");
    expect(children("Financials", "Integration Board")).toEqual(["Quotes", "Opportunities", "Freight Audit"]);
  });

  it("shows a trade manager Reports and Credit Overrides without any finance access", async () => {
    await bootAs(["trade_manager"]);
    openGroup("Financials");
    expect(children("Financials", "Integration Board")).toEqual(["Quotes", "Opportunities", "Reports", "Freight Audit", "Credit Overrides"]);
  });

  it("adds Reports, but never Credit Overrides, for a sales user with finance access", async () => {
    await bootAs(["sales"], { canViewFinance: true });
    openGroup("Financials");
    expect(children("Financials", "Integration Board")).toEqual(["Quotes", "Opportunities", "Reports", "Freight Audit"]);
  });

  it("takes Freight Audit out of the Dashboard group, which keeps Space Configurations and Archive", async () => {
    await bootAs(["admin"]);
    openGroup("Dashboard");
    expect(children("Dashboard", "Financials")).toEqual(["Space Configurations", "Archive"]);
  });

  it("lights up the Financials group — not Dashboard — while Freight Audit is open, and lights the page itself", async () => {
    window.location.hash = "#freight-audit";
    await bootAs(["admin"]);
    await waitFor(() => expect(labels()).toContain("Freight Audit"));
    const lit = label => !navButtons().find(b => b.label === label).el.style.borderLeft.includes("transparent");
    expect(lit("Financials")).toBe(true);        // the parent shows where you are…
    expect(lit("Freight Audit")).toBe(true);     // …and so does the page
    expect(lit("Dashboard")).toBe(false);        // Freight Audit used to light Dashboard; it no longer lives there
    expect(lit("Shipments")).toBe(false);
  });

  it("starts folded, like every other group", async () => {
    await bootAs(["admin"]);
    expect(children("Financials", "Integration Board")).toEqual([]);
    expect(localStorage.getItem("cd_navfold_financials")).toBe("0");
  });

  it("unfolds by itself when one of its pages is opened by address — a bookmark to Credit Overrides is never hidden", async () => {
    window.location.hash = "#credit-overrides";
    await bootAs(["trade_manager"]);
    await waitFor(() => expect(children("Financials", "Integration Board")).toContain("Credit Overrides"));
    expect(localStorage.getItem("cd_navfold_financials")).toBe("1");
  });

  it("does not unfold when a page outside the group is open", async () => {
    window.location.hash = "#shipments";
    await bootAs(["admin"]);
    expect(children("Financials", "Integration Board")).toEqual([]);
  });

  it("lets the group be folded by hand while one of its pages is open, until another page opens", async () => {
    window.location.hash = "#quotes";
    await bootAs(["admin"]);
    await waitFor(() => expect(children("Financials", "Integration Board")).toContain("Quotes"));
    fireEvent.click(foldOf("Financials"));                                  // fold it by hand…
    expect(children("Financials", "Integration Board")).toEqual([]);         // …and it stays folded on this page
  });

  it("opens the Financials hub when its own link is clicked", async () => {
    await bootAs(["admin"]);
    fireEvent.click(navButtons().find(b => b.label === "Financials").el);
    expect(await screen.findByRole("heading", { name: "Financials" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#financials");
    // the hub's cards follow the same role rules as the sidebar
    expect(await screen.findByTestId("financials-card-credit-overrides")).toBeInTheDocument();
  });
});
