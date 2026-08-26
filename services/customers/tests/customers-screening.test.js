/**
 * Customer Service — screening write-only upsert + override, and a deeper /group hierarchy walk
 * (multi-level tree, siblings, standalone-customer edge case).
 *
 * The MATCH decision (comparing company_name against the sanctions list) never happens here —
 * this service only ever persists an already-decided result, handed to it by the monolith (which
 * owns the in-memory sanctionsMap). See server.js's own header comment on the screening routes.
 *
 * Hits the service directly on its own port, no monolith involved.
 *
 * Usage:
 *   node services/customers/tests/customers-screening.test.js
 *
 * Prerequisites:
 *   - Customer Service running on :3008 (npm run customer-service)
 */

import http from "node:http";

const PORT = 3008;
const SECRET = process.env.CUSTOMER_SERVICE_SECRET || "cargoDesk-dev-customers-service-secret-do-not-use-in-prod";
let passed = 0;
let failed = 0;

function request(method, path, body, auth = true) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: PORT, path,
      headers: {
        "Content-Type": "application/json",
        ...(auth && { Authorization: `Bearer ${SECRET}` }),
        ...(payload && { "Content-Length": Buffer.byteLength(payload) }),
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

async function mkCustomer(name, parentId) {
  const res = await request("POST", "/internal/customers", { companyName: name, parentCustomerId: parentId || null });
  return res.body.id;
}

(async () => {
  const stamp = Date.now();
  let custId = null;
  let root = null, child1 = null, child2 = null, grandchild = null, standalone = null;
  try {
    console.log("Screening — write-only upsert (no sanctionsMap involved, result handed in)");
    custId = await mkCustomer(`Screening Test Co ${stamp}`);

    const beforeAny = await request("GET", `/internal/customers/${custId}/screening`);
    assert("no screening record yet returns null", beforeAny.body === null, JSON.stringify(beforeAny.body));

    const badResult = await request("PUT", `/internal/customers/${custId}/screening`, { result: "MAYBE" });
    assert("invalid result value rejected", badResult.status === 400);

    const write1 = await request("PUT", `/internal/customers/${custId}/screening`, {
      result: "HIT", hits: [{ entityName: "Some Sanctioned Entity", program: "TEST-PROGRAM", source: "OFAC-SDN" }],
    });
    assert("first screening write returns 200 with result HIT", write1.status === 200 && write1.body.result === "HIT", JSON.stringify(write1.body));
    assert("hits array round-trips", write1.body.hits.length === 1 && write1.body.hits[0].entityName === "Some Sanctioned Entity");

    const getRow = await request("GET", `/internal/customers/${custId}`);
    assert("customer's own screeningResult reflects the write (CUST_JOIN)", getRow.body.screeningResult === "HIT", JSON.stringify(getRow.body));

    const write2 = await request("PUT", `/internal/customers/${custId}/screening`, { result: "CLEAR", hits: [] });
    assert("re-screening upserts in place (ON CONFLICT), not a second row", write2.status === 200 && write2.body.result === "CLEAR");
    const screeningAfter = await request("GET", `/internal/customers/${custId}/screening`);
    assert("only one screening record exists after re-screening", screeningAfter.body.result === "CLEAR" && screeningAfter.body.overriddenAt === null);

    console.log("\nScreening override — pure state mutation, no sanctionsMap dependency");
    await request("PUT", `/internal/customers/${custId}/screening`, { result: "HIT", hits: [{ entityName: "X", program: "Y", source: "Z" }] });
    const noReason = await request("POST", `/internal/customers/${custId}/screening/override`, {});
    assert("override without a reason rejected", noReason.status === 400);
    const override = await request("POST", `/internal/customers/${custId}/screening/override`, { reason: "Confirmed false positive" });
    assert("override forces result to CLEAR", override.status === 200 && override.body.result === "CLEAR", JSON.stringify(override.body));
    assert("override records overriddenAt/overrideReason", !!override.body.overriddenAt && override.body.overrideReason === "Confirmed false positive");

    console.log("\n/group — deeper tree: root -> 2 children, one with its own grandchild");
    root = await mkCustomer(`Group Root ${stamp}`);
    child1 = await mkCustomer(`Group Child 1 ${stamp}`, root);
    child2 = await mkCustomer(`Group Child 2 ${stamp}`, root);
    grandchild = await mkCustomer(`Group Grandchild ${stamp}`, child1);

    const fromRoot = await request("GET", `/internal/customers/${root}/group`);
    assert("from root: all 4 members present", [root, child1, child2, grandchild].every(id => fromRoot.body.ids.includes(id)), JSON.stringify(fromRoot.body));
    assert("from root: root is first", fromRoot.body.ids[0] === root);

    const fromGrandchild = await request("GET", `/internal/customers/${grandchild}/group`);
    assert("from the grandchild: same group, same root-first ordering", fromGrandchild.body.ids[0] === root && fromGrandchild.body.ids.includes(child2), JSON.stringify(fromGrandchild.body));

    const fromChild2 = await request("GET", `/internal/customers/${child2}/group`);
    assert("from a leaf child (no children of its own): still resolves the full group, root first", fromChild2.body.ids[0] === root && fromChild2.body.ids.includes(grandchild));

    console.log("\n/group — a standalone customer with no parent and no children is its own group of 1");
    standalone = await mkCustomer(`Standalone ${stamp}`);
    const soloGroup = await request("GET", `/internal/customers/${standalone}/group`);
    assert("standalone customer's group is just itself", soloGroup.body.ids.length === 1 && soloGroup.body.ids[0] === standalone, JSON.stringify(soloGroup.body));

    const notFound = await request("GET", "/internal/customers/CUS-DOES-NOT-EXIST/group");
    assert("group walk on a nonexistent customer returns 404", notFound.status === 404);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    if (custId) await request("DELETE", `/internal/customers/${custId}`).catch(() => {});
    if (grandchild) await request("DELETE", `/internal/customers/${grandchild}`).catch(() => {});
    if (child1) await request("DELETE", `/internal/customers/${child1}`).catch(() => {});
    if (child2) await request("DELETE", `/internal/customers/${child2}`).catch(() => {});
    if (root) await request("DELETE", `/internal/customers/${root}`).catch(() => {});
    if (standalone) await request("DELETE", `/internal/customers/${standalone}`).catch(() => {});
  }
})();
