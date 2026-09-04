// A UN/LOCODE's first 2 characters are always its ISO-3166 country code by spec — the one place
// this derivation lives, so it can't independently drift between call sites (the shipment
// header pill's RouteSummaryBar and the Route Legs table's locked-row rendering both need it).
// PortCombobox.jsx doesn't use this — its own countryCode comes straight off the real
// port-search API response instead of being derived client-side.
export const countryCodeOf = code => (code || "").slice(0, 2).toUpperCase();
