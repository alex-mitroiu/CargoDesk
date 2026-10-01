// "Another reference under the same contract number has space" — the contract picker's suggestion
// when the space configuration a shipment would use is full (approved mockup:
// https://claude.ai/artifact/4BNCe9xBoNDguyPWVGhh8K). Input is the picker's own /api/allocations/match
// result, which is already narrowed to the shipment's POL/POD (incl. linked ports), date and carrier
// haulage, so routing and validity hold for every candidate; this adds the checks it can't do.

// Contracts list GP boxes as DC; shipments may carry either.
const normType = t => String(t || "").toUpperCase().replace(/GP$/, "DC");
export const containerTypeOf = c => normType(`${c.size || ""}${c.type || ""}`);

export const containerCounts = containers =>
  containers.reduce((m, c) => { const t = containerTypeOf(c); if (t) m[t] = (m[t] || 0) + 1; return m; }, {});

// Pending bookings count against the space: they'll most likely be confirmed, and leaving them out
// is how a configuration ends up overbooked. remainingTEU (allocated − confirmed) stays as the server sends it.
export const availableTEU = alloc => Math.max(0, (alloc.remainingTEU || 0) - (alloc.pendingTEU || 0));

export const isFull = (alloc, shipmentTEU) => shipmentTEU > 0 && shipmentTEU > availableTEU(alloc);

export function suggestAlternatives(allocs, full, { shipmentTEU = 0, principalId = "", principalName = "", containers = [] } = {}) {
  const number = full.contract?.contractNumber;
  if (!number) return [];
  const counts = containerCounts(containers);
  const types = Object.keys(counts);
  const hasDg = containers.some(c => c.isDg);
  const fullRates = full.contract.oceanRates || {};

  return allocs
    .filter(a => a.id !== full.id && a.carrierCode === full.carrierCode && a.contract?.contractNumber === number)
    .map(a => {
      const k = a.contract;
      const checks = [{ ok: true, label: `Covers ${a.pol} → ${a.pod}` }];
      if (!k.namedAccountId) checks.push({ ok: true, label: "Open to all accounts" });
      else if (k.namedAccountId === principalId) checks.push({ ok: true, label: `Open to ${principalName || k.namedAccount}` });
      else checks.push({ ok: false, label: `Reserved for ${k.namedAccount || "another account"}` });
      const contractTypes = (k.containerTypes || []).map(normType);
      const missing = contractTypes.length ? types.filter(t => !contractTypes.includes(t)) : [];
      if (types.length) checks.push(missing.length
        ? { ok: false, label: `No ${missing.join(", ")} on this contract` }
        : { ok: true, label: `${types.join(", ")} on contract` });
      if (hasDg) checks.push(k.dgAllowed ? { ok: true, label: "DG allowed" } : { ok: false, label: "DG not allowed" });
      const avail = availableTEU(a);
      checks.push(avail >= shipmentTEU
        ? { ok: true, label: `${avail} TEU available${a.pendingTEU ? ` (${a.pendingTEU} pending counted)` : ""}` }
        : { ok: false, label: `${avail} TEU available, shipment needs ${shipmentTEU}` });

      // Ocean-freight difference against the full reference, for the shipment's actual container mix.
      let rateDelta = null;
      for (const t of types) {
        const mine = k.oceanRates?.[t], theirs = fullRates[t];
        if (!mine || !theirs || mine.currency !== theirs.currency || mine.amount === theirs.amount) continue;
        rateDelta ||= { perType: {}, total: 0, currency: mine.currency };
        if (rateDelta.currency !== mine.currency) continue;
        rateDelta.perType[t] = mine.amount - theirs.amount;
        rateDelta.total += (mine.amount - theirs.amount) * counts[t];
      }
      return { alloc: a, checks, fits: checks.every(c => c.ok), rateDelta };
    })
    .sort((x, y) => (y.fits - x.fits) || (availableTEU(y.alloc) - availableTEU(x.alloc)));
}
