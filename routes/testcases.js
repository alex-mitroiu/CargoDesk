"use strict";

module.exports = function testCasesRoutes(app, ctx) {
  const { db, ok, err, uid, auth, requireRole, mapTestItem, mapTestCaseLink } = ctx;

  const write = requireRole(["operator", "admin"]);

  const TEST_TYPES = ["Test Folder", "Test Plan", "Test Run", "Test Case"];

  // ─── Test item helpers ────────────────────────────────────────────────────

  const TEST_ITEM_JOIN = `
    SELECT t.*, u.name AS assignee_name
    FROM   test_items t
    LEFT   JOIN users u ON t.assignee_id = u.id
  `;

  // Collect a test item's full descendant id set (folders/plans/runs/cases).
  const collectDescendants = (rootId) => {
    const all = db.prepare("SELECT id, parent_id FROM test_items").all();
    const byParent = new Map();
    for (const r of all) {
      if (!byParent.has(r.parent_id)) byParent.set(r.parent_id, []);
      byParent.get(r.parent_id).push(r.id);
    }
    const out = [];
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop();
      for (const childId of byParent.get(id) || []) { out.push(childId); stack.push(childId); }
    }
    return out;
  };

  // ─── Test Items ───────────────────────────────────────────────────────────

  app.get("/api/test-items", auth(), (req, res) => {
    const { shipmentId, projectId } = req.query;
    let query  = `${TEST_ITEM_JOIN} WHERE 1=1`;
    const params = [];
    if (shipmentId) { query += " AND t.shipment_id=?"; params.push(shipmentId); }
    if (projectId)  { query += " AND (t.project_id=? OR t.project_id IS NULL)"; params.push(projectId); }
    query += " ORDER BY t.status, t.position, t.created_at";
    ok(res, db.prepare(query).all(...params).map(mapTestItem));
  });

  app.post("/api/test-items", write, (req, res) => {
    const {
      title, type, description = "", priority = "Medium", status = "Ready",
      shipmentId = null, parentId = null, assigneeId = null, dueDate = null, testNotes = null,
      projectId = null, versionId = null,
    } = req.body || {};
    if (!title) return err(res, "title required");
    if (!TEST_TYPES.includes(type)) return err(res, `type must be one of: ${TEST_TYPES.join(", ")}`);
    const id  = `TST-${uid()}`;
    const pos = (db.prepare("SELECT MAX(position) AS m FROM test_items WHERE status=?").get(status)?.m ?? -1) + 1;
    db.prepare(`
      INSERT INTO test_items
        (id, type, title, description, priority, status, position, created_at,
         shipment_id, parent_id, assignee_id, due_date, test_notes, project_id, version_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, type, title, description, priority, status, pos, new Date().toISOString(),
           shipmentId || null, parentId || null, assigneeId || null, dueDate || null,
           testNotes || null, projectId || null, versionId || null);
    ok(res, mapTestItem(db.prepare(`${TEST_ITEM_JOIN} WHERE t.id=?`).get(id)), 201);
  });

  app.put("/api/test-items/:id", write, (req, res) => {
    const existing = db.prepare("SELECT * FROM test_items WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const {
      title       = existing.title,
      type        = existing.type,
      description = existing.description ?? "",
      priority    = existing.priority    ?? "Medium",
      status      = existing.status      ?? "Ready",
      position    = existing.position    ?? 0,
      shipmentId  = existing.shipment_id,
      parentId    = existing.parent_id,
      assigneeId  = existing.assignee_id,
      dueDate     = existing.due_date,
      testNotes   = existing.test_notes,
      projectId   = existing.project_id,
      versionId   = existing.version_id,
    } = req.body || {};
    if (!TEST_TYPES.includes(type)) return err(res, `type must be one of: ${TEST_TYPES.join(", ")}`);
    const info = db.prepare(`
      UPDATE test_items
      SET title=?, type=?, description=?, priority=?, status=?, position=?,
          shipment_id=?, parent_id=?, assignee_id=?, due_date=?, test_notes=?, project_id=?, version_id=?
      WHERE id=?
    `).run(title, type, description, priority, status, position,
           shipmentId || null, parentId || null, assigneeId || null, dueDate || null,
           testNotes || null, projectId || null, versionId || null, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, mapTestItem(db.prepare(`${TEST_ITEM_JOIN} WHERE t.id=?`).get(req.params.id)));
  });

  app.delete("/api/test-items/:id", write, (req, res) => {
    const existing = db.prepare("SELECT id FROM test_items WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const ids = [req.params.id, ...collectDescendants(req.params.id)];
    const placeholders = ids.map(() => "?").join(",");
    db.exec("BEGIN");
    try {
      db.prepare(`DELETE FROM test_case_links WHERE case_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM test_items WHERE id IN (${placeholders})`).run(...ids);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      return err(res, "Delete failed", 500);
    }
    ok(res, { deleted: req.params.id, cascaded: ids.length - 1 });
  });

  // ─── Story Links (Test Case ↔ ticket, fixed "Tests" / "Is tested by") ─────

  app.get("/api/test-items/:id/story-links", auth(), (req, res) => {
    const rows = db.prepare("SELECT * FROM test_case_links WHERE case_id=?").all(req.params.id);
    ok(res, rows.map(l => {
      const ticket = db.prepare("SELECT id, title, status, type FROM tickets WHERE id=?").get(l.ticket_id);
      return { ...mapTestCaseLink(l), displayType: "Tests",
        ticket: ticket || { id: l.ticket_id, title: l.ticket_id, status: "", type: "" } };
    }));
  });

  app.post("/api/test-items/:id/story-links", write, (req, res) => {
    const { ticketId } = req.body || {};
    if (!ticketId) return err(res, "ticketId required");
    const testCase = db.prepare("SELECT id FROM test_items WHERE id=? AND type='Test Case'").get(req.params.id);
    if (!testCase) return err(res, "Test case not found", 404);
    if (!db.prepare("SELECT id FROM tickets WHERE id=?").get(ticketId)) return err(res, "Ticket not found", 404);
    if (db.prepare("SELECT id FROM test_case_links WHERE case_id=? AND ticket_id=?").get(req.params.id, ticketId))
      return err(res, "Link already exists");
    const id = `TCL-${uid()}`;
    db.prepare("INSERT INTO test_case_links (id,case_id,ticket_id,created_at) VALUES (?,?,?,?)")
      .run(id, req.params.id, ticketId, new Date().toISOString());
    ok(res, { id, caseId: req.params.id, ticketId }, 201);
  });

  app.delete("/api/test-case-links/:id", write, (req, res) => {
    const info = db.prepare("DELETE FROM test_case_links WHERE id=?").run(req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.id });
  });

  // ─── Reverse direction: a ticket's "Tested by" test cases ─────────────────

  app.get("/api/tickets/:id/tested-by", auth(), (req, res) => {
    const rows = db.prepare("SELECT * FROM test_case_links WHERE ticket_id=?").all(req.params.id);
    ok(res, rows.map(l => {
      const testCase = db.prepare("SELECT id, title, status, type FROM test_items WHERE id=?").get(l.case_id);
      return { ...mapTestCaseLink(l), displayType: "Is tested by",
        case: testCase || { id: l.case_id, title: l.case_id, status: "", type: "" } };
    }));
  });
};
