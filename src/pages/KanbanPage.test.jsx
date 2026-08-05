import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthContext } from "../AuthContext";
import KanbanPage from "./KanbanPage";

// Same auto-mock-the-real-shape approach as App.test.jsx — see that file's comment for why.
vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  const mockDeep = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [
    k,
    typeof v === "function" ? vi.fn().mockResolvedValue([])
      : (v && typeof v === "object") ? mockDeep(v)
      : v,
  ]));
  return { ...actual, api: mockDeep(actual.api) };
});

import { api } from "../api";

const CAN_EDIT_CTX = {
  user: { id: "USR-1", name: "Test Admin" },
  activeRole: "admin", activeRoles: ["admin"],
  canEdit: true, canEditShipments: true, canManageConfigs: true, canManageMdm: true,
  canEditKanban: true, isAdmin: true, isViewer: false, isOccBk: false, isTradeManager: false,
  activeOffice: null, userOffices: [], allOffices: true, setActiveOffice: () => {},
};

const TICKETS = [
  { id: "TKT-AAA111", title: "Fix login redirect bug", type: "Bug", status: "Ready",
    priority: "High", section: "General", position: 0, createdAt: "2026-08-01T00:00:00Z" },
  { id: "TKT-BBB222", title: "Add export button to Dashboard", type: "Story", status: "In Progress",
    priority: "Medium", section: "Dashboard", position: 0, createdAt: "2026-08-01T00:00:00Z" },
];

function renderBoard() {
  return render(
    <AuthContext.Provider value={CAN_EDIT_CTX}>
      <KanbanPage shipments={[]} />
    </AuthContext.Provider>
  );
}

describe("KanbanPage — ticket board", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.tickets.list.mockResolvedValue(TICKETS);
  });

  it("renders existing tickets from the board", async () => {
    renderBoard();
    expect(await screen.findByText("Fix login redirect bug")).toBeInTheDocument();
    expect(screen.getByText("Add export button to Dashboard")).toBeInTheDocument();
  });

  it("creates a new ticket via the Add Ticket flow", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Fix login redirect bug");

    await user.click(screen.getByRole("button", { name: "＋ Add Ticket" }));
    expect(await screen.findByRole("heading", { name: "New Ticket" })).toBeInTheDocument();

    // The Title <label> isn't programmatically associated with its <input> (no htmlFor/id) —
    // a real, pre-existing gap in TicketModal, not something to paper over here — so this
    // targets the input by its placeholder instead of getByLabelText.
    const titleInput = screen.getByPlaceholderText("e.g. Wire VesselCombobox to ShipmentForm");
    await user.type(titleInput, "Write frontend tests for KanbanPage");

    await user.click(screen.getByRole("button", { name: "Create Ticket" }));

    await waitFor(() => expect(api.tickets.create).toHaveBeenCalledTimes(1));
    expect(api.tickets.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Write frontend tests for KanbanPage" })
    );
  });

  it("hides the Add Ticket control for a viewer without canEditKanban", async () => {
    render(
      <AuthContext.Provider value={{ ...CAN_EDIT_CTX, canEditKanban: false }}>
        <KanbanPage shipments={[]} />
      </AuthContext.Provider>
    );
    await screen.findByText("Fix login redirect bug");
    expect(screen.queryByRole("button", { name: "＋ Add Ticket" })).not.toBeInTheDocument();
  });
});
