// DCSA code lists the screens need, mirrored from lib/dcsa/codes.js (the backend's single source; the
// two don't share a module, same split as CONTRACT_TYPES). dcsaCodes.test.js fails if they drift.
// The code is what CargoDesk stores and sends; the label is what a screen shows.

export const BOOKING_STATUS_LABEL = {
  RECEIVED: "Received", PENDING_UPDATE: "Update required", UPDATE_RECEIVED: "Update received",
  CONFIRMED: "Confirmed", PENDING_AMENDMENT: "Amendment required", REJECTED: "Rejected",
  DECLINED: "Declined", CANCELLED: "Cancelled", COMPLETED: "Completed",
};
export const AMENDED_BOOKING_STATUS_LABEL = {
  AMENDMENT_RECEIVED: "Amendment received", AMENDMENT_CONFIRMED: "Amendment confirmed",
  AMENDMENT_DECLINED: "Amendment declined", AMENDMENT_CANCELLED: "Amendment cancelled",
};
export const BOOKING_CANCELLATION_STATUS_LABEL = {
  CANCELLATION_RECEIVED: "Cancellation requested", CANCELLATION_DECLINED: "Cancellation declined",
  CANCELLATION_CONFIRMED: "Cancellation confirmed",
};

const ALL = { ...BOOKING_STATUS_LABEL, ...AMENDED_BOOKING_STATUS_LABEL, ...BOOKING_CANCELLATION_STATUS_LABEL };
export const dcsaLabel = code => ALL[code] || code || "";

// The carrier decisions the built-in DCSA simulator accepts (lib/dcsa-simulator ACTIONS), in the order
// a carrier would usually reach for them, with how each is presented.
export const CARRIER_ACTIONS = {
  confirm:             { label: "Confirm",               variant: "primary" },
  confirmAmendment:    { label: "Confirm amendment",     variant: "primary" },
  confirmCancellation: { label: "Confirm cancellation",  variant: "primary" },
  requestUpdate:       { label: "Ask for an update",     variant: "secondary", feedback: true },
  requestAmendment:    { label: "Ask for an amendment",  variant: "secondary", feedback: true },
  declineAmendment:    { label: "Decline amendment",     variant: "secondary", feedback: true },
  declineCancellation: { label: "Decline cancellation",  variant: "secondary", feedback: true },
  reject:              { label: "Reject",                variant: "danger",    feedback: true },
  decline:             { label: "Decline",               variant: "danger",    feedback: true },
};
