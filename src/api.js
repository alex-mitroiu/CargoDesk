const BASE = "/api";

import { toast } from "./toast";

const req = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
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
    list:   ()           => req("GET",    "/allocations"),
    create: (data)       => req("POST",   "/allocations", data),
    update: (id, data)   => req("PUT",    `/allocations/${id}`, data),
    remove:    (id)          => req("DELETE", `/allocations/${id}`),
    conflicts: (params)      => req("GET",    `/allocations/conflicts?${new URLSearchParams(params)}`),
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
    list:   (p = {})     => req("GET",    `/countries?${new URLSearchParams(p)}`),
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
  tickets: {
    list:   ()          => req("GET",    "/tickets"),
    create: (data)      => req("POST",   "/tickets", data),
    update: (id, data)  => req("PUT",    `/tickets/${id}`, data),
    remove: (id)        => req("DELETE", `/tickets/${id}`),
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