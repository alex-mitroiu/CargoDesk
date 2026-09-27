// Which of the Financials group's pages a person can see — ONE definition for the sidebar group and the
// Financials hub's cards, so the two can never disagree about who sees what. The rules are exactly the ones
// each page's own sidebar link followed before the group existed; grouping changed where the links sit, not
// who gets them:
//
//   Quotes, Opportunities, Freight Audit, Statements   every role
//   Credit Overrides                       admin, operator, trade_manager (the roles the backend queue accepts)
//   Reports                                admin, anyone with finance access, or a trade_manager (their own
//                                          lane-scoped Invoice Collections status override lives there) — and
//                                          only while the finance view is switched on in Application Settings
//   GL Export                              admin, operator, or anyone with finance access — a controller-level
//                                          action, not a trade_manager's own lane concern (matches how FX
//                                          Revaluation, inside Reports, is finance-only too)
//
// The order here is the order the group and the hub list them in.
export const FINANCIALS_PAGES = ["quotes", "opportunities", "reports", "freight-audit", "credit-overrides", "customer-statements", "gl-export"];

const CREDIT_OVERRIDE_ROLES = ["admin", "operator", "trade_manager"];
const GL_EXPORT_ROLES = ["admin", "operator"];

export function canSeeFinancialsPage(key, { roles = [], canViewFinance = false, financeViewEnabled = true } = {}) {
  if (key === "credit-overrides") return roles.some(r => CREDIT_OVERRIDE_ROLES.includes(r));
  if (key === "reports") {
    return financeViewEnabled && (roles.includes("admin") || !!canViewFinance || roles.includes("trade_manager"));
  }
  if (key === "gl-export") return roles.some(r => GL_EXPORT_ROLES.includes(r)) || !!canViewFinance;
  return FINANCIALS_PAGES.includes(key);
}

/**
 * The pages to show this person, in group order. `isEnabled(pageKey)` is the app's module switch (a page whose
 * module is turned off in settings is hidden everywhere), applied on top of the role rules.
 */
export const visibleFinancialsPages = (who, isEnabled = () => true) =>
  FINANCIALS_PAGES.filter(key => isEnabled(key) && canSeeFinancialsPage(key, who));
