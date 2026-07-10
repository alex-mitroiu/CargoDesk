"use strict";

module.exports = function kanbanRoutes(app, ctx) {
  const { db, ok, err, uid, mapTicket, mapTicketLink, inverseLinkLabel } = ctx;

  const TICKET_JOIN = `
    SELECT t.*, u.name AS assignee_name
    FROM   tickets t
    LEFT   JOIN users u ON t.assignee_id = u.id
  `;

  app.get("/api/tickets", (req, res) => {
    const { shipmentId } = req.query;
    if (shipmentId) {
      return ok(res, db.prepare(`${TICKET_JOIN} WHERE t.shipment_id=? ORDER BY t.status, t.position, t.created_at`).all(shipmentId).map(mapTicket));
    }
    ok(res, db.prepare(`${TICKET_JOIN} ORDER BY t.status, t.position, t.created_at`).all().map(mapTicket));
  });

  app.post("/api/tickets", (req, res) => {
    const {
      title, section = '', description = '', priority = 'Medium', status = 'Ready',
      shipmentId = null, type = 'Task', version = '',
      parentId = null, assigneeId = null, dueDate = null, testNotes = null,
    } = req.body;
    if (!title) return err(res, "title required");
    const id  = `TKT-${uid()}`;
    const pos = (db.prepare("SELECT MAX(position) AS m FROM tickets WHERE status=?").get(status)?.m ?? -1) + 1;
    db.prepare(`
      INSERT INTO tickets
        (id, title, section, description, priority, status, position, created_at,
         shipment_id, type, version, parent_id, assignee_id, due_date, test_notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, title, section, description, priority, status, pos, new Date().toISOString(),
           shipmentId || null, type, version, parentId || null, assigneeId || null, dueDate || null,
           testNotes || null);
    ok(res, mapTicket(db.prepare(`${TICKET_JOIN} WHERE t.id=?`).get(id)), 201);
  });

  app.put("/api/tickets/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM tickets WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const {
      title = existing.title, section = existing.section ?? '', description = existing.description ?? '',
      priority = existing.priority ?? 'Medium', status = existing.status ?? 'Ready', position = existing.position ?? 0,
      shipmentId = existing.shipment_id, type = existing.type ?? 'Task', version = existing.version ?? '',
      parentId = existing.parent_id, assigneeId = existing.assignee_id, dueDate = existing.due_date, testNotes = existing.test_notes,
    } = req.body;
    const info = db.prepare(`
      UPDATE tickets
      SET title=?, section=?, description=?, priority=?, status=?, position=?,
          shipment_id=?, type=?, version=?, parent_id=?, assignee_id=?, due_date=?, test_notes=?
      WHERE id=?
    `).run(title, section, description, priority, status, position,
           shipmentId || null, type, version, parentId || null, assigneeId || null, dueDate || null,
           testNotes || null, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, mapTicket(db.prepare(`${TICKET_JOIN} WHERE t.id=?`).get(req.params.id)));
  });

  app.delete("/api/tickets/:id", (req, res) => {
    const info = db.prepare("DELETE FROM tickets WHERE id=?").run(req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.id });
  });

  app.get("/api/tickets/:id/links", (req, res) => {
    const rows = db.prepare("SELECT * FROM ticket_links WHERE from_id=? OR to_id=?").all(req.params.id, req.params.id);
    const result = rows.map(l => {
      const isOut   = l.from_id === req.params.id;
      const otherId = isOut ? l.to_id : l.from_id;
      const other   = db.prepare("SELECT id, title, status, type FROM tickets WHERE id=?").get(otherId);
      return { ...mapTicketLink(l), direction: isOut ? "out" : "in",
        displayType: isOut ? l.link_type : inverseLinkLabel(l.link_type),
        otherTicketId: otherId, otherTicket: other || { id: otherId, title: otherId, status: "", type: "" } };
    });
    ok(res, result);
  });

  app.post("/api/tickets/:id/links", (req, res) => {
    const { toId, linkType } = req.body || {};
    if (!toId || !linkType) return err(res, "toId and linkType required");
    if (!db.prepare("SELECT id FROM tickets WHERE id=?").get(toId)) return err(res, "Target ticket not found", 404);
    if (db.prepare("SELECT id FROM ticket_links WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)").get(req.params.id, toId, toId, req.params.id))
      return err(res, "Link already exists");
    const id = `LNK-${uid()}`;
    db.prepare("INSERT INTO ticket_links (id,from_id,to_id,link_type,created_at) VALUES (?,?,?,?,?)").run(id, req.params.id, toId, linkType, new Date().toISOString());
    ok(res, { id, fromId: req.params.id, toId, linkType }, 201);
  });

  app.delete("/api/ticket-links/:id", (req, res) => {
    const info = db.prepare("DELETE FROM ticket_links WHERE id=?").run(req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.id });
  });
};
