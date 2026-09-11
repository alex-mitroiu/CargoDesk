// ─── Test status helpers ───────────────────────────────────────────────────
// Shared between TestItemPreview and TestSuiteView for Test Case pass/fail
// rollups, Jira-style status labels, and run-level stat aggregation.

export const TC_PASS    = new Set(["Done", "Ready to Deploy", "Released"]);
export const TC_FAIL    = new Set(["Testing Failed"]);
export const TC_BLOCKED = new Set(["Cancelled"]);
export const TC_ACTIVE  = new Set(["In Testing", "In Progress"]);

export const TC_JIRA_LABEL = {
  "Done": "Pass", "Ready to Deploy": "Pass", "Released": "Pass",
  "Testing Failed": "Fail",
  "Cancelled": "Blocked",
  "In Testing": "In Progress", "In Progress": "In Progress",
};
export const tcLabel = status => TC_JIRA_LABEL[status] || "Not Executed";

export const JIRA_COLOR = {
  "Pass":         "#22c55e",
  "Fail":         "#ef4444",
  "Blocked":      "#f97316",
  "In Progress":  "#3b82f6",
  "Not Executed": "#6b7280",
};

export const tcStatusColor = status => JIRA_COLOR[tcLabel(status)] || "#6b7280";

export const tcStatusIcon = status => {
  const lbl = tcLabel(status);
  return lbl === "Pass" ? "✓" : lbl === "Fail" ? "✗" : lbl === "Blocked" ? "⊘" : lbl === "In Progress" ? "⚡" : "○";
};

export const runStats = cases => {
  const passed  = cases.filter(c => TC_PASS.has(c.status)).length;
  const failed  = cases.filter(c => TC_FAIL.has(c.status)).length;
  const blocked = cases.filter(c => TC_BLOCKED.has(c.status)).length;
  const active  = cases.filter(c => TC_ACTIVE.has(c.status)).length;
  const pending = cases.length - passed - failed - blocked - active;
  return { passed, failed, blocked, active, pending, total: cases.length };
};
