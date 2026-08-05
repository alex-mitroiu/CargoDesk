import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
});
