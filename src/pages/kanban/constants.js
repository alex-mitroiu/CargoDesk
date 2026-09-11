import { T } from "../../tokens";

// ─── Shared Kanban constants ───────────────────────────────────────────────────

export const COLUMNS = ["Ready", "In Progress", "Done", "In Testing", "Testing Failed", "Ready to Deploy", "Released"];

export const SECTIONS = [
  "General", "Shipments", "Dashboard", "Contracts", "Cost Control",
  "Vessels", "Port Locations", "Carriers", "Trade Lanes", "Countries",
  "UN Location Codes", "Customers", "API / Backend", "UI / UX", "Landing Page", "Kanban",
];

export const LINK_TYPES = ["Relates to", "Blocks", "Duplicates", "Implements"];

export const TYPES = ["Epic", "Story", "Feature", "Bug", "Improvement", "Task", "Chore"];
export const TEST_TYPES = ["Test Folder", "Test Plan", "Test Run", "Test Case"];
export const TEST_STATUSES = ["Ready", "In Progress", "In Testing", "Testing Failed", "Done", "Ready to Deploy", "Released", "Cancelled"];
export const TEST_PARENT_TYPES = { "Test Run": ["Test Plan"], "Test Case": ["Test Run", "Test Plan"] };

export const TYPE_ICON = {
  Epic:          "⚡",
  Story:         "📖",
  Feature:       "✨",
  Bug:           "🦟",
  Improvement:   "🔨",
  Task:          "☑",
  Chore:         "🔧",
  "Test Plan":   "📋",
  "Test Run":    "▶",
  "Test Case":   "🧪",
  "Test Folder": "📁",
};

export const TYPE_VARIANT = {
  Epic:          "warning",
  Story:         "info",
  Feature:       "info",
  Bug:           "danger",
  Improvement:   "success",
  Task:          "default",
  Chore:         "warning",
  "Test Plan":   "warning",
  "Test Run":    "info",
  "Test Case":   "default",
  "Test Folder": "warning",
};

export const PRIORITIES = ["Critical", "High", "Medium", "Low"];

export const PRIORITY_VARIANT = {
  Critical: "danger", High: "warning", Medium: "info", Low: "default",
};

export const PRIORITY_DOT = {
  Critical: T?.danger  || "#ef4444",
  High:     T?.warning || "#f59e0b",
  Medium:   T?.info    || "#3b82f6",
  Low:      T?.border  || "#6b7280",
};

export const COL_ACCENT = {
  "Ready":          "#6366f1",
  "In Progress":    "#f59e0b",
  "Done":           "#22c55e",
  "In Testing":     "#06b6d4",
  "Testing Failed":  "#ef4444",
  "Ready to Deploy": "#f97316",
  "Released":        "#8b5cf6",
};

export const PREVIEW_LIMIT = 5;

// Returns true when a due date string (YYYY-MM-DD) is strictly in the past.
export const isOverdue = d => d && d < new Date().toISOString().slice(0, 10);

// Deterministic colour for an assignee avatar based on their user ID.
// Cycles through a fixed palette so the same person always gets the same colour.
export const AVATAR_PALETTE = ["#6366f1","#f59e0b","#22c55e","#06b6d4","#ef4444","#8b5cf6","#ec4899","#14b8a6"];
export const avatarColor = id => AVATAR_PALETTE[(id || "").split("").reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_PALETTE.length];

// Allowed parent-ticket types when picking a parent (Epic/Story). Shared by
// ParentPickerModal and TicketModal (which reads it directly for validation).
export const PARENT_TYPES = ["Epic", "Story"];
