const BASE = "/api";
export const TOKEN_KEY       = "cargodesk_token";
export const ACTIVE_ROLE_KEY = "cargodesk_active_role";
export const ACTIVE_OFFICE_KEY = "cargodesk_active_office";

import { toast } from "./toast";

const req = async (method, path, body) => {
  const token      = localStorage.getItem(TOKEN_KEY);
  const activeRole = localStorage.getItem(ACTIVE_ROLE_KEY);
  const activeOffice = localStorage.getItem(ACTIVE_OFFICE_KEY);
  const headers = {};
  if (body)          headers["Content-Type"]   = "application/json";
  if (token)         headers["Authorization"]  = `Bearer ${token}`;
  if (activeRole)    headers["X-Active-Role"]  = activeRole;
  if (activeOffice)  headers["X-Office-Id"]    = activeOffice;

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
    list: (shipmentId, params = {}) => req("GET", `/shipments/${shipmentId}/events?${new URLSearchParams(params)}`),
  },
  shipmentMessages: {
    list: (shipmentId)       => req("GET",  `/shipments/${shipmentId}/messages`),
    post: (shipmentId, data) => req("POST", `/shipments/${shipmentId}/messages`, data),
  },
  ediMessages: {
    list:               (shipmentId)       => req("GET",  `/shipments/${shipmentId}/edi-messages`),
    sendBookingRequest: (shipmentId, data) => req("POST", `/shipments/${shipmentId}/edi-messages/booking-request`, data),
  },
  legs: {
    list:   (shipmentId)              => req("GET",    `/shipments/${shipmentId}/legs`),
    create: (shipmentId, data)        => req("POST",   `/shipments/${shipmentId}/legs`, data),
    update: (shipmentId, legId, data) => req("PUT",    `/shipments/${shipmentId}/legs/${legId}`, data),
    remove: (shipmentId, legId)       => req("DELETE", `/shipments/${shipmentId}/legs/${legId}`),
  },
  shipments: {
    list:   ()        => req("GET",    "/shipments"),
    get:    (id)      => req("GET",    `/shipments/${id}`),
    create: (data)    => req("POST",   "/shipments", data),
    update: (id, data)=> req("PUT",    `/shipments/${id}`, data),
    remove: (id)      => req("DELETE", `/shipments/${id}`),
    shareToken: (id)  => req("POST",   `/shipments/${id}/share-token`),
  },
  containers: {
    list:   ()        => req("GET",    "/containers"),
    create: (data)    => req("POST",   "/containers", data),
    update: (id, data)=> req("PUT",    `/containers/${id}`, data),
    remove: (id)      => req("DELETE", `/containers/${id}`),
    events:      (id)       => req("GET",    `/containers/${id}/events`),
    addEvent:    (id, data) => req("POST",   `/containers/${id}/events`, data),
    removeEvent: (eventId)  => req("DELETE", `/container-events/${eventId}`),
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
    getCountries:       (code)       => req("GET",    `/trade-lanes/${code}/countries`),
    setCountries:       (code, iso2s)=> req("PUT",    `/trade-lanes/${code}/countries`, { iso2s }),
    transitSuggestion:  (pol, pod)   => req("GET",    `/trade-lanes/transit-suggestion?pol=${pol}&pod=${pod}`),
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
    identifiers: {
      list:   (cid)            => req("GET",    `/customers/${cid}/identifiers`),
      create: (cid, data)      => req("POST",   `/customers/${cid}/identifiers`, data),
      update: (cid, iid, data) => req("PUT",    `/customers/${cid}/identifiers/${iid}`, data),
      remove: (cid, iid)       => req("DELETE", `/customers/${cid}/identifiers/${iid}`),
    },
    screening: {
      get:      (cid)       => req("GET",  `/customers/${cid}/screening`),
      run:      (cid)       => req("POST", `/customers/${cid}/screen`, {}),
      override: (cid, data) => req("POST", `/customers/${cid}/screening/override`, data),
    },
    documents: {
      list:     (cid)           => req("GET",    `/customers/${cid}/documents`),
      upload:   (cid, data)     => req("POST",   `/customers/${cid}/documents`, data),
      remove:   (cid, did)      => req("DELETE", `/customers/${cid}/documents/${did}`),
      downloadUrl: (cid, did)   => `/api/customers/${cid}/documents/${did}/download`,
    },
  },
  tickets: {
    list:          (p = {})       => req("GET",    `/tickets${Object.keys(p).length ? "?" + new URLSearchParams(p) : ""}`),
    forShipment:   (shipmentId)   => req("GET",    `/tickets?shipmentId=${encodeURIComponent(shipmentId)}`),
    create:        (data)         => req("POST",   "/tickets", data),
    update:        (id, data)     => req("PUT",    `/tickets/${id}`, data),
    remove:        (id)           => req("DELETE", `/tickets/${id}`),
    links:         (id)           => req("GET",    `/tickets/${id}/links`),
    addLink:       (id, data)     => req("POST",   `/tickets/${id}/links`, data),
    removeLink:    (linkId)       => req("DELETE", `/ticket-links/${linkId}`),
    testedBy:      (id)           => req("GET",    `/tickets/${id}/tested-by`),
  },
  testItems: {
    list:            (p = {})   => req("GET",    `/test-items${Object.keys(p).length ? "?" + new URLSearchParams(p) : ""}`),
    create:          (data)     => req("POST",   "/test-items", data),
    update:          (id, data) => req("PUT",    `/test-items/${id}`, data),
    remove:          (id)       => req("DELETE", `/test-items/${id}`),
    storyLinks:      (id)       => req("GET",    `/test-items/${id}/story-links`),
    addStoryLink:    (id, data) => req("POST",   `/test-items/${id}/story-links`, data),
    removeStoryLink: (id)       => req("DELETE", `/test-case-links/${id}`),
  },
  kbProjects: {
    list:   ()           => req("GET",    "/kb/projects"),
    create: (data)       => req("POST",   "/kb/projects", data),
    update: (id, data)   => req("PUT",    `/kb/projects/${id}`, data),
    remove: (id)         => req("DELETE", `/kb/projects/${id}`),
  },
  kbVersions: {
    list:   (projectId)       => req("GET",    `/kb/projects/${projectId}/versions`),
    create: (projectId, data) => req("POST",   `/kb/projects/${projectId}/versions`, data),
    update: (id, data)        => req("PUT",    `/kb/versions/${id}`, data),
    remove: (id)              => req("DELETE", `/kb/versions/${id}`),
  },
  kbColumns: {
    list:    (projectId)            => req("GET",   `/kb/projects/${projectId}/columns`),
    create:  (projectId, data)      => req("POST",  `/kb/projects/${projectId}/columns`, data),
    update:  (id, data)             => req("PUT",   `/kb/columns/${id}`, data),
    reorder: (projectId, order)     => req("PATCH", `/kb/projects/${projectId}/columns`, { order }),
    remove:  (id)                   => req("DELETE",`/kb/columns/${id}`),
  },
  contracts: {
    search:     (p = {})  => req("GET",    `/contracts?${new URLSearchParams(p)}`),
    find:       (p = {})  => req("GET",    `/contracts/search?${new URLSearchParams(p)}`),
    match:      (p = {})  => req("GET",    `/contracts/match?${new URLSearchParams(p)}`),
    revalidate: (ref)     => req("GET",    `/contracts/revalidate?ref=${encodeURIComponent(ref)}`),
    get:        (id)      => req("GET",    `/contracts/${id}`),
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
    resetToContract:    (shipmentId, d = {})   => req("POST",   `/shipments/${shipmentId}/cost-lines/reset-to-contract`, d),
    updateCarrierCosts: (shipmentId, d = {})   => req("POST",   `/shipments/${shipmentId}/cost-lines/update-carrier-costs`, d),
    rateSnapshots:      (shipmentId)           => req("GET",    `/shipments/${shipmentId}/rate-snapshots`),
    events:         (shipmentId)               => req("GET",    `/shipments/${shipmentId}/cost-line-events`),
    actualize:      (shipmentId, lineId, d)    => req("PATCH",  `/shipments/${shipmentId}/cost-lines/${lineId}/actualize`, d),
    post:           (shipmentId, lineId)       => req("PATCH",  `/shipments/${shipmentId}/cost-lines/${lineId}/post`, {}),
    postBatch:      (shipmentId, ids)          => req("POST",   `/shipments/${shipmentId}/cost-lines/post-batch`, { ids }),
  },
  containerPackages: {
    list:   (containerId)     => req("GET",    `/containers/${containerId}/packages`),
    create: (containerId, d) => req("POST",   `/containers/${containerId}/packages`, d),
    update: (id, d)           => req("PUT",    `/container-packages/${id}`, d),
    remove: (id)              => req("DELETE", `/container-packages/${id}`),
  },
  chargeCodes: {
    list:   ()      => req("GET",    "/charge-code-definitions"),
    create: (d)     => req("POST",   "/charge-code-definitions", d),
    update: (id, d) => req("PUT",    `/charge-code-definitions/${id}`, d),
    remove: (id)    => req("DELETE", `/charge-code-definitions/${id}`),
  },
  services: {
    list:   (shipmentId)             => req("GET",    `/shipments/${shipmentId}/services`),
    create: (shipmentId, d)          => req("POST",   `/shipments/${shipmentId}/services`, d),
    update: (shipmentId, serviceId, d) => req("PATCH", `/shipments/${shipmentId}/services/${serviceId}`, d),
    remove: (shipmentId, serviceId)  => req("DELETE", `/shipments/${shipmentId}/services/${serviceId}`),
  },
  loadingPlan: {
    list:   (shipmentId, serviceId)      => req("GET", `/shipments/${shipmentId}/services/${serviceId}/loading-plan`),
    update: (shipmentId, serviceId, containerId, d) =>
      req("PUT", `/shipments/${shipmentId}/services/${serviceId}/loading-plan/${containerId}`, d),
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
    login:          (email, password)               => req("POST", "/auth/login", { email, password }),
    me:             ()                               => req("GET",  "/auth/me"),
    ssoConfig:      ()                               => req("GET",  "/auth/sso/config"),
    changePassword: (currentPassword, newPassword)   => req("POST", "/auth/change-password", { currentPassword, newPassword }),
  },
  users: {
    list:           ()           => req("GET",    "/users"),
    create:         (data)       => req("POST",   "/users", data),
    update:         (id, data)   => req("PATCH",  `/users/${id}`, data),
    remove:         (id)         => req("DELETE", `/users/${id}`),
    revokeSessions: (id)         => req("POST",   `/users/${id}/revoke-sessions`),
  },
  adminEvents: {
    list: (p = {}) => req("GET", `/admin/events?${new URLSearchParams(p)}`),
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
  schedules: {
    search:  (p = {})         => req("GET",    `/schedules/search?${new URLSearchParams(p)}`),
    list:    (shipmentId)     => req("GET",    `/shipments/${shipmentId}/schedules`),
    save:    (shipmentId, d)  => req("POST",   `/shipments/${shipmentId}/schedules`, d),
    update:  (shipmentId, id, d) => req("PUT", `/shipments/${shipmentId}/schedules/${id}`, d),
    remove:  (shipmentId, id) => req("DELETE", `/shipments/${shipmentId}/schedules/${id}`),
    events:  (shipmentId)     => req("GET",    `/shipments/${shipmentId}/schedule-events`),
  },
  vessels: {
    search: (q = "")          => req("GET",    `/vessels/search?q=${encodeURIComponent(q)}`),
    list:   (p = {})          => req("GET",    `/vessels?${new URLSearchParams(p)}`),
    get:    (imo)             => req("GET",    `/vessels/${imo}`),
    create: (data)            => req("POST",   "/vessels", data),
    update: (imo, data)       => req("PUT",    `/vessels/${imo}`, data),
    remove: (imo)             => req("DELETE", `/vessels/${imo}`),
  },
  export: {
    shipmentsCSV: async () => {
      const token = localStorage.getItem("cargodesk_token");
      const activeRole = localStorage.getItem("cargodesk_active_role");
      const headers = { Authorization: `Bearer ${token}` };
      if (activeRole) headers["X-Active-Role"] = activeRole;
      const res = await fetch("/api/export/shipments.csv", { headers });
      if (!res.ok) throw new Error("CSV export failed");
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      const a    = document.createElement("a");
      a.href = url; a.download = `shipments-${date}.csv`; a.click();
      URL.revokeObjectURL(url);
    },
    dashboardXlsx: async () => {
      const token = localStorage.getItem("cargodesk_token");
      const activeRole = localStorage.getItem("cargodesk_active_role");
      const headers = { Authorization: `Bearer ${token}` };
      if (activeRole) headers["X-Active-Role"] = activeRole;
      const res = await fetch("/api/export/dashboard/xlsx", { headers });
      if (!res.ok) throw new Error("XLSX export failed");
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      const a    = document.createElement("a");
      a.href = url; a.download = `cargodesk-dashboard-${date}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    },
    dashboardTemplate: async () => {
      const token = localStorage.getItem("cargodesk_token");
      const activeRole = localStorage.getItem("cargodesk_active_role");
      const headers = { Authorization: `Bearer ${token}` };
      if (activeRole) headers["X-Active-Role"] = activeRole;
      const res = await fetch("/api/export/dashboard/template", { headers });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || "Template export failed");
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      const a    = document.createElement("a");
      a.href = url; a.download = `cargodesk-dashboard-template-${date}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    },
  },
  ai: {
    settings: () => req("GET", "/ai/settings"),
    chat:     (messages, context = {}) => req("POST", "/ai/chat", { messages, context }),
  },
  offices: {
    list:           ()               => req("GET",    "/offices"),
    create:         (data)           => req("POST",   "/offices", data),
    update:         (id, data)       => req("PUT",    `/offices/${id}`, data),
    remove:         (id)             => req("DELETE", `/offices/${id}`),
    stats:          (id)             => req("GET",    `/offices/${id}/stats`),
    userOffices:    (userId)         => req("GET",    `/users/${userId}/offices`),
    assignOffice:   (userId, data)   => req("POST",   `/users/${userId}/offices`, data),
    setDefault:     (userId, offId)  => req("PATCH",  `/users/${userId}/offices/${offId}/set-default`, {}),
    removeOffice:   (userId, offId)  => req("DELETE", `/users/${userId}/offices/${offId}`),
  },
  branches: {
    list:   ()           => req("GET",    "/branches"),
    get:    (id)         => req("GET",    `/branches/${id}`),
    offices:(id)         => req("GET",    `/branches/${id}/offices`),
    create: (data)       => req("POST",   "/branches", data),
    update: (id, data)   => req("PUT",    `/branches/${id}`, data),
    remove: (id)         => req("DELETE", `/branches/${id}`),
  },
  orgCountries: {
    list:   ()           => req("GET",    "/org-countries"),
    create: (data)       => req("POST",   "/org-countries", data),
    update: (code, data) => req("PUT",    `/org-countries/${code}`, data),
    remove: (code)       => req("DELETE", `/org-countries/${code}`),
  },
};