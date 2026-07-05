const BASE = "/api";
export const TOKEN_KEY    = "cargodesk_token";
export const ACTIVE_ROLE_KEY = "cargodesk_active_role";

import { toast } from "./toast";

const req = async (method, path, body) => {
  const token      = localStorage.getItem(TOKEN_KEY);
  const activeRole = localStorage.getItem(ACTIVE_ROLE_KEY);
  const headers = {};
  if (body)        headers["Content-Type"]   = "application/json";
  if (token)       headers["Authorization"]  = `Bearer ${token}`;
  if (activeRole)  headers["X-Active-Role"]  = activeRole;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    window.dispatchEvent(new Event("cargodesk:logout"));
    throw new Error("Session expired — please sign in again");
  }

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const msg = e.error || e.message || `HTTP ${res.status}`;
    if (res.status >= 500) toast.error(`Server error: ${msg}`);
    throw new Error(msg);
  }
  return res.json();
};

export const api = {
  carriers: {
    list:   ()           => req("GET",    "/carriers"),
    create: (data)       => req("POST",   "/carriers", data),
    update: (code, data) => req("PUT",    `/carriers/${code}`, data),
    remove: (code)       => req("DELETE", `/carriers/${code}`),
  },
  statusLog: {
    list: (shipmentId) => req("GET", `/shipments/${shipmentId}/status-log`),
  },
  shipmentEvents: {
    list: (shipmentId) => req("GET", `/shipments/${shipmentId}/events`),
  },
  shipmentMessages: {
    list: (shipmentId)       => req("GET",  `/shipments/${shipmentId}/messages`),
    post: (shipmentId, data) => req("POST", `/shipments/${shipmentId}/messages`, data),
  },
  legs: {
    list:   (shipmentId)              => req("GET",    `/shipments/${shipmentId}/legs`),
    create: (shipmentId, data)        => req("POST",   `/shipments/${shipmentId}/legs`, data),
    update: (shipmentId, legId, data) => req("PUT",    `/shipments/${shipmentId}/legs/${legId}`, data),
    remove: (shipmentId, legId)       => req("DELETE", `/shipments/${shipmentId}/legs/${legId}`),
  },
  shipments: {
    list:   ()        => req("GET",    "/shipments"),
    create: (data)    => req("POST",   "/shipments", data),
    update: (id, data)=> req("PUT",    `/shipments/${id}`, data),
    remove: (id)      => req("DELETE", `/shipments/${id}`),
  },
  containers: {
    list:   ()        => req("GET",    "/containers"),
    create: (data)    => req("POST",   "/containers", data),
    update: (id, data)=> req("PUT",    `/containers/${id}`, data),
    remove: (id)      => req("DELETE", `/containers/${id}`),
  },
  commodities: {
    list:   (p = {}) => req("GET",    `/commodities?${new URLSearchParams(p)}`),
    search: (q)      => req("GET",    `/commodities/search?q=${encodeURIComponent(q)}`),
    get:    (code)   => req("GET",    `/commodities/${code}`),
    create: (data)   => req("POST",   "/commodities", data),
    update: (code, data) => req("PUT", `/commodities/${code}`, data),
    remove: (code)   => req("DELETE", `/commodities/${code}`),
  },
  portLanes: (unlocode) => req("GET", `/port-locations/${unlocode}/lanes`),
  portLinks: (unlocode) => req("GET", `/port-locations/${unlocode}/links`),
  allocations: {
    list:      ()            => req("GET",    "/allocations"),
    create:    (data)        => req("POST",   "/allocations", data),
    update:    (id, data)    => req("PUT",    `/allocations/${id}`, data),
    remove:    (id)          => req("DELETE", `/allocations/${id}`),
    conflicts: (params)      => req("GET",    `/allocations/conflicts?${new URLSearchParams(params)}`),
    match:     (params)      => req("GET",    `/allocations/match?${new URLSearchParams(params)}`),
  },
  ports: {
    search: (params)     => req("GET",    `/port-locations?${new URLSearchParams(params)}`),
    get:    (code)       => req("GET",    `/port-locations/${code}`),
    create: (data)       => req("POST",   "/port-locations", data),
    update: (code, data) => req("PUT",    `/port-locations/${code}`, data),
    remove: (code)       => req("DELETE", `/port-locations/${code}`),
  },
  linkedPorts: {
    list:   ()           => req("GET",    "/linked-ports"),
    create: (data)       => req("POST",   "/linked-ports", data),
    update: (id, data)   => req("PUT",    `/linked-ports/${id}`, data),
    remove: (id)         => req("DELETE", `/linked-ports/${id}`),
  },
  regions: {
    list:   ()           => req("GET",    "/regions"),
    create: (data)       => req("POST",   "/regions", data),
    update: (code, data) => req("PUT",    `/regions/${code}`, data),
    remove: (code)       => req("DELETE", `/regions/${code}`),
  },
  countries: {
    list:   (p = {})     => req("GET",    `/countries?${new URLSearchParams({ limit: 300, ...p })}`),
    create: (data)       => req("POST",   "/countries", data),
    update: (iso2, data) => req("PUT",    `/countries/${iso2}`, data),
    remove: (iso2)       => req("DELETE", `/countries/${iso2}`),
  },
  unlocodes: {
    search: (p = {})          => req("GET",    `/unlocodes?${new URLSearchParams(p)}`),
  },
  tradeLanes: {
    list:          ()              => req("GET",    "/trade-lanes"),
    create:        (data)          => req("POST",   "/trade-lanes", data),
    update:        (code, data)    => req("PUT",    `/trade-lanes/${code}`, data),
    remove:        (code)          => req("DELETE", `/trade-lanes/${code}`),
    getCountries:  (code)          => req("GET",    `/trade-lanes/${code}/countries`),
    setCountries:  (code, iso2s)   => req("PUT",    `/trade-lanes/${code}/countries`, { iso2s }),
  },
  countryLocations: {
    list: (iso2, p = {})      => req("GET",    `/countries/${iso2}/locations?${new URLSearchParams(p)}`),
  },
  countryLanes: {
    list: ()                  => req("GET",    "/country-trade-lanes"),
    set:  (iso2, lanes)       => req("PUT",    `/countries/${iso2}/trade-lanes`, { lanes }),
  },
  customers: {
    list:           (p = {})   => req("GET",    `/customers?${new URLSearchParams(p)}`),
    get:            (id)       => req("GET",    `/customers/${id}`),
    create:         (data)     => req("POST",   "/customers", data),
    update:         (id, data) => req("PUT",    `/customers/${id}`, data),
    remove:         (id)       => req("DELETE", `/customers/${id}`),
    sanctionsCheck: ()         => req("GET",    "/customers/sanctions-check"),
  },
  tickets: {
    list:       ()          => req("GET",    "/tickets"),
    create:     (data)      => req("POST",   "/tickets", data),
    update:     (id, data)  => req("PUT",    `/tickets/${id}`, data),
    remove:     (id)        => req("DELETE", `/tickets/${id}`),
    links:      (id)        => req("GET",    `/tickets/${id}/links`),
    addLink:    (id, data)  => req("POST",   `/tickets/${id}/links`, data),
    removeLink: (linkId)    => req("DELETE", `/ticket-links/${linkId}`),
  },
  contracts: {
    search:  (p = {})     => req("GET",    `/contracts?${new URLSearchParams(p)}`),
    find:    (p = {})     => req("GET",    `/contracts/search?${new URLSearchParams(p)}`),
    match:   (p = {})     => req("GET",    `/contracts/match?${new URLSearchParams(p)}`),
    get:     (id)         => req("GET",    `/contracts/${id}`),
    create:  (data)       => req("POST",   "/contracts", data),
    update:  (id, data)   => req("PUT",    `/contracts/${id}`, data),
    remove:  (id)         => req("DELETE", `/contracts/${id}`),
  },
  entityEvents: {
    list: (type, id) => req("GET", `/entity-events/${type}/${id}`),
  },
  sanctions: {
    status:    ()        => req("GET",  "/sanctions/status"),
    sync:      ()        => req("POST", "/sanctions/sync"),
    importCsv: (csv)     => req("POST", "/sanctions/import-csv", { csv }),
    entries:   (p = {})  => req("GET",  `/sanctions/entries?${new URLSearchParams(p)}`),
  },
  screening: {
    get:            (id)       => req("GET",  `/shipments/${id}/screening`),
    run:            (id)       => req("POST", `/shipments/${id}/screen`),
    override:       (id, data) => req("POST", `/shipments/${id}/screening/override`, data),
    complianceHits: ()         => req("GET",  "/shipments/compliance-hits"),
  },
  costLines: {
    list:           (shipmentId)               => req("GET",    `/shipments/${shipmentId}/cost-lines`),
    create:         (shipmentId, d)            => req("POST",   `/shipments/${shipmentId}/cost-lines`, d),
    update:         (shipmentId, lineId, d)    => req("PUT",    `/shipments/${shipmentId}/cost-lines/${lineId}`, d),
    remove:         (shipmentId, lineId)       => req("DELETE", `/shipments/${shipmentId}/cost-lines/${lineId}`),
    importContract: (shipmentId, d = {})       => req("POST",   `/shipments/${shipmentId}/cost-lines/import-contract`, d),
    events:         (shipmentId)               => req("GET",    `/shipments/${shipmentId}/cost-line-events`),
  },
  milestones: {
    list:   (shipmentId)       => req("GET",    `/shipments/${shipmentId}/milestones`),
    init:   (shipmentId, d={}) => req("POST",   `/shipments/${shipmentId}/milestones/init`, d),
    update: (id, d)            => req("PUT",    `/milestones/${id}`, d),
    remove: (id)               => req("DELETE", `/milestones/${id}`),
  },
  milestoneTemplates: {
    list:   ()           => req("GET",    "/milestone-templates"),
    create: (d)          => req("POST",   "/milestone-templates", d),
    update: (id, d)      => req("PUT",    `/milestone-templates/${id}`, d),
    remove: (id)         => req("DELETE", `/milestone-templates/${id}`),
  },
  margin: {
    summary: () => req("GET", "/margin/summary"),
  },
  systemMessages: {
    list:   ()     => req("GET",    "/system-messages"),
    all:    ()     => req("GET",    "/system-messages/all"),
    create: (data) => req("POST",   "/system-messages", data),
    remove: (id)   => req("DELETE", `/system-messages/${id}`),
  },
  auth: {
    login: (email, password) => req("POST", "/auth/login", { email, password }),
    me:    ()                => req("GET",  "/auth/me"),
  },
  users: {
    list:   ()           => req("GET",    "/users"),
    create: (data)       => req("POST",   "/users", data),
    update: (id, data)   => req("PATCH",  `/users/${id}`, data),
    remove: (id)         => req("DELETE", `/users/${id}`),
  },
  userAccess: {
    list:   (userId)       => req("GET",    `/users/${userId}/access-configs`),
    create: (userId, data) => req("POST",   `/users/${userId}/access-configs`, data),
    remove: (configId)     => req("DELETE", `/access-configs/${configId}`),
  },
  userScope: {
    list:   (userId)       => req("GET",    `/users/${userId}/scope`),
    create: (userId, data) => req("POST",   `/users/${userId}/scope`, data),
    remove: (itemId)       => req("DELETE", `/scope-items/${itemId}`),
  },
  documents: {
    list:     (shipmentId)       => req("GET",    `/shipments/${shipmentId}/documents`),
    upload:   (shipmentId, data) => req("POST",   `/shipments/${shipmentId}/documents`, data),
    patch:    (docId, data)      => req("PATCH",  `/documents/${docId}`, data),
    remove:   (docId)            => req("DELETE", `/documents/${docId}`),
    download: async (docId, filename) => {
      const token = localStorage.getItem("cargodesk_token");
      const res = await fetch(`/api/documents/${docId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    },
  },
  fx: {
    rates: () => req("GET", "/fx/rates"),
  },
  settings: {
    get:    ()       => req("GET", "/settings"),
    update: (data)   => req("PUT", "/settings", data),
  },
  vessels: {
    search: (q = "")          => req("GET",    `/vessels/search?q=${encodeURIComponent(q)}`),
    list:   (p = {})          => req("GET",    `/vessels?${new URLSearchParams(p)}`),
    get:    (imo)             => req("GET",    `/vessels/${imo}`),
    create: (data)            => req("POST",   "/vessels", data),
    update: (imo, data)       => req("PUT",    `/vessels/${imo}`, data),
    remove: (imo)             => req("DELETE", `/vessels/${imo}`),
  },
};