/**
 * Office-Side Permissions Epic (TKT-Z0LB0W)
 *
 * Covers Phases 1-4 end to end against one real scratch shipment straddling two scratch
 * offices (Export/SE and Import/SI): the fixed-side write gates (Schedules, Cargo/Containers,
 * Carrier Booking, Shipping Instructions), the deliberately-shared Container Events, the
 * record's-own-side gate (Export/Import Services), the role-based gate on the shared Parties
 * endpoint (Customs Broker/Trucker, with an un-sided role left open), the Customs Filing
 * filing-type split (Option A), the line-level Accounting read filter (charge_code side), the
 * myOfficeSide field GET /api/shipments now computes, and the vessel_arrived-completes ops-
 * automation trigger (dedup + office-manager assignment).
 *
 * Usage:
 *   node tests/office-side-permissions.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - occ_bk is the write-capable role used to prove the gate itself (admin/operator bypass
 *     office-side restriction entirely by design, same as they bypass office-scoped visibility)
 */

import http from "node:http";

const BASE = "http://localhost:3001";
let passed = 0;
let failed = 0;

function request(method, path, body, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: 3001, path,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(payload && { "Content-Length": Buffer.byteLength(payload) }),
        ...extraHeaders,
      },
    };
    const req = http.request(opts, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function login(email, password) {
  const { status, body } = await request("POST", "/api/auth/login", { email, password });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

(async () => {
  let admin;
  const created = { offices: [], shipments: [], users: [], tickets: [] };
  try {
    admin = await login("claudeagent@localhost", "TestFixture!2026Zq");
    const rand = Math.random().toString(36).slice(2, 8);

    console.log("Setup — two scratch offices, one shipment straddling both, two scoped users");
    const offA = await request("POST", "/api/offices", { name: `OSP Export ${rand}`, unlocode: `Y${rand.slice(0, 4).toUpperCase()}`, countryCode: "NL", department: "SE" }, admin);
    const offB = await request("POST", "/api/offices", { name: `OSP Import ${rand}`, unlocode: `Z${rand.slice(0, 4).toUpperCase()}`, countryCode: "US", department: "SI" }, admin);
    assert("export office created", offA.status === 201, JSON.stringify(offA.body));
    assert("import office created", offB.status === 201, JSON.stringify(offB.body));
    created.offices.push(offA.body.id, offB.body.id);

    const manager = await request("POST", "/api/users", { email: `osp-manager-${rand}@test.local`, name: "OSP Import Manager", roles: ["occ_bk"], password: "OspFixture!2026Zq" }, admin);
    created.users.push(manager.body.id);
    const setManager = await request("PUT", `/api/offices/${offB.body.id}`, { managerUserId: manager.body.id }, admin);
    assert("import office manager set", setManager.status === 200, JSON.stringify(setManager.body));

    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      etd: "2026-06-01", eta: "2026-06-25", incoterm: "FOB", commodityCode: "8471",
      emoOfficeId: offA.body.id, imoOfficeId: offB.body.id,
      shipperName: "OSP Shipper Co", consigneeName: "OSP Consignee Co",
    }, admin);
    assert("shipment created, straddling both offices", ship.status === 201, JSON.stringify(ship.body));
    const shipmentId = ship.body.id;
    created.shipments.push(shipmentId);

    async function makeUser(officeId, label) {
      const email = `osp-${label}-${rand}@test.local`;
      const u = await request("POST", "/api/users", { email, name: `OSP ${label}`, roles: ["occ_bk"], password: "OspFixture!2026Zq" }, admin);
      assert(`${label} user created`, u.status === 201, JSON.stringify(u.body));
      created.users.push(u.body.id);
      await request("POST", `/api/users/${u.body.id}/offices`, { officeId }, admin);
      return login(email, "OspFixture!2026Zq");
    }
    const exportToken = await makeUser(offA.body.id, "export-user");
    const importToken = await makeUser(offB.body.id, "import-user");
    const H_A = { "X-Office-Id": offA.body.id }, H_B = { "X-Office-Id": offB.body.id };

    console.log("\nmyOfficeSide — GET /api/shipments (list) and GET /api/shipments/:id (single)");
    const singleAsExport = await request("GET", `/api/shipments/${shipmentId}`, null, exportToken, H_A);
    assert("single-GET: export user -> myOfficeSide 'export'", singleAsExport.body.myOfficeSide === "export", singleAsExport.body.myOfficeSide);
    const singleAsImport = await request("GET", `/api/shipments/${shipmentId}`, null, importToken, H_B);
    assert("single-GET: import user -> myOfficeSide 'import'", singleAsImport.body.myOfficeSide === "import", singleAsImport.body.myOfficeSide);
    const singleAsAdmin = await request("GET", `/api/shipments/${shipmentId}`, null, admin);
    assert("single-GET: admin -> myOfficeSide 'unrestricted'", singleAsAdmin.body.myOfficeSide === "unrestricted");
    const listAsExport = await request("GET", "/api/shipments", null, exportToken, H_A);
    const rowAsExport = listAsExport.body.find(s => s.id === shipmentId);
    assert("list-GET: export user's own row -> myOfficeSide 'export' (the actual data source shipment sub-pages use)", rowAsExport?.myOfficeSide === "export", JSON.stringify(rowAsExport?.myOfficeSide));

    console.log("\nSchedules (legs) — fixed export-edit");
    const legBlocked = await request("POST", `/api/shipments/${shipmentId}/legs`, { legType: "SEA", pol: "NLRTM", pod: "USNYC" }, importToken, H_B);
    assert("import user blocked from adding a leg (403)", legBlocked.status === 403, JSON.stringify(legBlocked.body));
    const legAllowed = await request("POST", `/api/shipments/${shipmentId}/legs`, { legType: "SEA", pol: "NLRTM", pod: "USNYC" }, exportToken, H_A);
    assert("export user can add a leg (201)", legAllowed.status === 201, JSON.stringify(legAllowed.body));
    if (legAllowed.status === 201) {
      const legDelBlocked = await request("DELETE", `/api/shipments/${shipmentId}/legs/${legAllowed.body.id}`, null, importToken, H_B);
      assert("import user blocked from deleting the leg (403)", legDelBlocked.status === 403);
      const legDelAllowed = await request("DELETE", `/api/shipments/${shipmentId}/legs/${legAllowed.body.id}`, null, exportToken, H_A);
      assert("export user can delete the leg (200)", legDelAllowed.status === 200);
    }

    console.log("\nCargo/Containers — fixed export-edit");
    const ctrBlocked = await request("POST", "/api/containers", { shipmentId, size: "40", type: "HC" }, importToken, H_B);
    assert("import user blocked from adding a container (403)", ctrBlocked.status === 403, JSON.stringify(ctrBlocked.body));
    const ctrAllowed = await request("POST", "/api/containers", { shipmentId, size: "40", type: "HC" }, exportToken, H_A);
    assert("export user can add a container (201)", ctrAllowed.status === 201, JSON.stringify(ctrAllowed.body));
    const containerId = ctrAllowed.body?.id;

    console.log("\nContainer Events — deliberately shared (mixed export/import lifecycle), NOT gated");
    if (containerId) {
      const evByImport = await request("POST", `/api/shipments/${shipmentId}/containers/${containerId}/events`, { eventType: "Discharged", occurredAt: "2026-06-20" }, importToken, H_B);
      assert("import user can record a Discharged event (201)", evByImport.status === 201, JSON.stringify(evByImport.body));
      const evByExport = await request("POST", `/api/shipments/${shipmentId}/containers/${containerId}/events`, { eventType: "Gate In", occurredAt: "2026-06-02" }, exportToken, H_A);
      assert("export user can record a Gate In event (201)", evByExport.status === 201, JSON.stringify(evByExport.body));
    }

    console.log("\nCarrier Booking — fixed export-edit");
    const confirmBlocked = await request("PATCH", `/api/shipments/${shipmentId}/carrier-booking/confirm`, { bookingRef: "OSP-BOOKING" }, importToken, H_B);
    assert("import user blocked from confirming a carrier booking (403)", confirmBlocked.status === 403, JSON.stringify(confirmBlocked.body));
    const confirmAllowed = await request("PATCH", `/api/shipments/${shipmentId}/carrier-booking/confirm`, { bookingRef: "OSP-BOOKING" }, exportToken, H_A);
    assert("export user can confirm a carrier booking (200)", confirmAllowed.status === 200, JSON.stringify(confirmAllowed.body));

    console.log("\nShipping Instructions — fixed export-edit");
    const siBlocked = await request("PUT", `/api/shipments/${shipmentId}/shipping-instructions`, { specialInstructions: "x" }, importToken, H_B);
    assert("import user blocked from saving Shipping Instructions (403)", siBlocked.status === 403, JSON.stringify(siBlocked.body));
    const siAllowed = await request("PUT", `/api/shipments/${shipmentId}/shipping-instructions`, { specialInstructions: "Handle with care" }, exportToken, H_A);
    assert("export user can save Shipping Instructions (201)", siAllowed.status === 201, JSON.stringify(siAllowed.body));

    console.log("\nCustoms Filing — split by filing type (Option A), not a whole-page gate");
    const aesByImport = await request("POST", `/api/shipments/${shipmentId}/customs-filings`, { filingType: "AES_EEI" }, importToken, H_B);
    assert("import user blocked from creating an AES/EEI (export) filing (403)", aesByImport.status === 403, JSON.stringify(aesByImport.body));
    const isfByExport = await request("POST", `/api/shipments/${shipmentId}/customs-filings`, { filingType: "ISF_AMS" }, exportToken, H_A);
    assert("export user blocked from creating an ISF/AMS (import) filing (403)", isfByExport.status === 403, JSON.stringify(isfByExport.body));

    console.log("\nExport/Import Services — gated by the service record's OWN side, not a fixed section side");
    const expSvcByImport = await request("POST", `/api/shipments/${shipmentId}/services`, { side: "Export", serviceType: "Loading" }, importToken, H_B);
    assert("import user blocked from creating an Export service (403)", expSvcByImport.status === 403, JSON.stringify(expSvcByImport.body));
    const impSvcByExport = await request("POST", `/api/shipments/${shipmentId}/services`, { side: "Import", serviceType: "Delivery" }, exportToken, H_A);
    assert("export user blocked from creating an Import service (403)", impSvcByExport.status === 403, JSON.stringify(impSvcByExport.body));
    const impSvcByImport = await request("POST", `/api/shipments/${shipmentId}/services`, { side: "Import", serviceType: "Delivery" }, importToken, H_B);
    assert("import user can create an Import service (201)", impSvcByImport.status === 201, JSON.stringify(impSvcByImport.body));
    if (impSvcByImport.status === 201) {
      const hijack = await request("PATCH", `/api/shipments/${shipmentId}/services/${impSvcByImport.body.id}`, { notes: "hijack attempt" }, exportToken, H_A);
      assert("export user blocked from editing that Import service (403)", hijack.status === 403);
    }

    console.log("\nParties — role-based gate on the shared endpoint (Customs Broker/Trucker), un-sided roles stay open");
    const broker = await request("POST", "/api/customers", { companyName: `OSP Broker Co ${rand}` }, admin);
    const brokerImportByExport = await request("POST", `/api/shipments/${shipmentId}/parties`, { role: "Customs Broker (Import)", customerId: broker.body.id, customerName: broker.body.companyName }, exportToken, H_A);
    assert("export user blocked from assigning Customs Broker (Import) (403)", brokerImportByExport.status === 403, JSON.stringify(brokerImportByExport.body));
    const brokerImportByImport = await request("POST", `/api/shipments/${shipmentId}/parties`, { role: "Customs Broker (Import)", customerId: broker.body.id, customerName: broker.body.companyName }, importToken, H_B);
    assert("import user can assign Customs Broker (Import) (201)", brokerImportByImport.status === 201, JSON.stringify(brokerImportByImport.body));
    const truckerByImport = await request("POST", `/api/shipments/${shipmentId}/parties`, { role: "Trucker (Pre-carriage)", customerId: broker.body.id, customerName: broker.body.companyName }, importToken, H_B);
    assert("import user blocked from assigning Trucker (Pre-carriage) (403)", truckerByImport.status === 403, JSON.stringify(truckerByImport.body));
    const forwarderByImport = await request("POST", `/api/shipments/${shipmentId}/parties`, { role: "Forwarder", customerId: broker.body.id, customerName: broker.body.companyName }, importToken, H_B);
    assert("import user can assign the un-sided 'Forwarder' role (201) — not blanket-gated", forwarderByImport.status === 201, JSON.stringify(forwarderByImport.body));

    console.log("\nCost Lines — line-level READ filtering by charge_code side; WRITE deliberately not gated");
    const clExport = await request("POST", `/api/shipments/${shipmentId}/cost-lines`, { type: "BUY", chargeCode: "Ocean Freight", amount: 4200 }, admin);
    const clImport = await request("POST", `/api/shipments/${shipmentId}/cost-lines`, { type: "BUY", chargeCode: "Destination THC", amount: 410 }, admin);
    const clShared = await request("POST", `/api/shipments/${shipmentId}/cost-lines`, { type: "BUY", chargeCode: `OSP Unclassified ${rand}`, amount: 99 }, admin);
    assert("all 3 scratch cost lines created", clExport.status === 201 && clImport.status === 201 && clShared.status === 201);
    const linesAsExport = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, exportToken, H_A);
    const codesAsExport = linesAsExport.body.map(l => l.chargeCode);
    assert("export user sees the Export-owned line", codesAsExport.includes("Ocean Freight"));
    assert("export user does NOT see the Import-owned line", !codesAsExport.includes("Destination THC"));
    assert("export user sees the unclassified/shared line", codesAsExport.includes(`OSP Unclassified ${rand}`));
    const linesAsImport = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, importToken, H_B);
    const codesAsImport = linesAsImport.body.map(l => l.chargeCode);
    assert("import user sees the Import-owned line", codesAsImport.includes("Destination THC"));
    assert("import user does NOT see the Export-owned line", !codesAsImport.includes("Ocean Freight"));
    const linesAsAdmin = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, admin);
    assert("admin (unrestricted) sees all 3 lines", linesAsAdmin.body.length >= 3);
    const clWriteByImport = await request("POST", `/api/shipments/${shipmentId}/cost-lines`, { type: "BUY", chargeCode: "Ocean Freight", amount: 100 }, importToken, H_B);
    assert("import user can still WRITE an Export-owned cost line (201) — write is not side-gated by design", clWriteByImport.status === 201, JSON.stringify(clWriteByImport.body));

    console.log("\nvessel_arrived trigger — fires once, addressed to the IMO office's manager");
    await request("POST", `/api/shipments/${shipmentId}/milestones/init`, null, admin);
    const milestones = await request("GET", `/api/shipments/${shipmentId}/milestones`, null, admin);
    const vesselArrived = milestones.body.find(m => m.milestoneKey === "vessel_arrived") || milestones.body.find(m => m.label === "Vessel Arrived");
    assert("vessel_arrived milestone row exists after init", !!vesselArrived, JSON.stringify(milestones.body));
    const completeMs = await request("PUT", `/api/shipments/${shipmentId}/milestones/${vesselArrived.id}`, { completedAt: "2026-06-19" }, admin);
    assert("vessel_arrived marked complete", completeMs.status === 200, JSON.stringify(completeMs.body));

    const sweep1 = await request("POST", "/api/test/run-ops-automation-sweep", null, admin);
    assert("ops automation sweep runs (200)", sweep1.status === 200, JSON.stringify(sweep1.body));
    const ticketsAfterSweep1 = await request("GET", "/api/tickets", null, admin);
    const handoffTicket = ticketsAfterSweep1.body.find(t => t.sourceType === "vessel_arrived_import_handoff" && t.shipmentId === shipmentId);
    assert("a handoff ticket was created for this shipment", !!handoffTicket, JSON.stringify(handoffTicket));
    assert("the handoff ticket is assigned to the import office's manager", handoffTicket?.assigneeId === manager.body.id, `got ${handoffTicket?.assigneeId}`);
    assert("the handoff ticket names the handoff in its title", handoffTicket && /import handoff/i.test(handoffTicket.title));
    if (handoffTicket) created.tickets.push(handoffTicket.id);

    await request("POST", "/api/test/run-ops-automation-sweep", null, admin);
    const ticketsAfterSweep2 = await request("GET", "/api/tickets", null, admin);
    const dupCount = ticketsAfterSweep2.body.filter(t => t.sourceType === "vessel_arrived_import_handoff" && t.shipmentId === shipmentId).length;
    assert("re-running the sweep does not create a duplicate handoff ticket", dupCount === 1, `found ${dupCount}`);

    // A second shipment whose IMO office has NO manager set — proves "unassigned, not skipped."
    const offC = await request("POST", "/api/offices", { name: `OSP Import No-Manager ${rand}`, unlocode: `W${rand.slice(0, 4).toUpperCase()}`, countryCode: "US", department: "SI" }, admin);
    created.offices.push(offC.body.id);
    const ship2 = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USLAX", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      etd: "2026-06-01", eta: "2026-06-27", incoterm: "FOB", commodityCode: "8471",
      emoOfficeId: offA.body.id, imoOfficeId: offC.body.id,
    }, admin);
    created.shipments.push(ship2.body.id);
    await request("POST", `/api/shipments/${ship2.body.id}/milestones/init`, null, admin);
    const ms2 = await request("GET", `/api/shipments/${ship2.body.id}/milestones`, null, admin);
    const va2 = ms2.body.find(m => m.milestoneKey === "vessel_arrived") || ms2.body.find(m => m.label === "Vessel Arrived");
    await request("PUT", `/api/shipments/${ship2.body.id}/milestones/${va2.id}`, { completedAt: "2026-06-21" }, admin);

    // A third shipment left with vessel_arrived incomplete — proves no premature ticket.
    const ship3 = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      etd: "2026-06-01", eta: "2026-06-28", incoterm: "FOB", commodityCode: "8471",
      emoOfficeId: offA.body.id, imoOfficeId: offB.body.id,
    }, admin);
    created.shipments.push(ship3.body.id);
    await request("POST", `/api/shipments/${ship3.body.id}/milestones/init`, null, admin);

    await request("POST", "/api/test/run-ops-automation-sweep", null, admin);
    const ticketsFinal = await request("GET", "/api/tickets", null, admin);
    const t2 = ticketsFinal.body.find(t => t.sourceType === "vessel_arrived_import_handoff" && t.shipmentId === ship2.body.id);
    const t3 = ticketsFinal.body.find(t => t.sourceType === "vessel_arrived_import_handoff" && t.shipmentId === ship3.body.id);
    assert("shipment with no office manager still gets a handoff ticket (unassigned, not skipped)", !!t2, JSON.stringify(t2));
    assert("...and that ticket has no assignee", t2 && !t2.assigneeId, `got ${t2?.assigneeId}`);
    assert("shipment with vessel_arrived NOT completed gets no handoff ticket at all", !t3, JSON.stringify(t3));
    if (t2) created.tickets.push(t2.id);

  } catch (e) {
    console.error("Fatal:", e.message);
    failed++;
  } finally {
    if (admin) {
      console.log("\nCleanup");
      for (const id of created.tickets)   await request("DELETE", `/api/tickets/${id}`, null, admin).catch(() => {});
      for (const id of created.shipments) await request("DELETE", `/api/shipments/${id}`, null, admin).catch(() => {});
      for (const id of created.users)     await request("DELETE", `/api/users/${id}`, null, admin).catch(() => {});
      for (const id of created.offices)   await request("DELETE", `/api/offices/${id}`, null, admin).catch(() => {});
    }
  }

  console.log("\n" + "─".repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
