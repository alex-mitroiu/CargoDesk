/**
 * MDM Page Scaffold — copy this file, rename it, and replace every TODO.
 *
 * Usage:
 *   1. cp src/scaffold/MdmPageScaffold.jsx src/pages/mdm/MdmYourEntityPage.jsx
 *   2. Replace every TODO marker below.
 *   3. Add the import + route + NavBtn in App.jsx (see bottom of this file).
 *   4. Add GET/POST/PUT/DELETE endpoints in server.js.
 *   5. Add api.yourEntity.* wrappers in api.js.
 *   6. Delete this comment block.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import ActionMenu from "../../components/primitives/ActionMenu";
import Pagination from "../../components/primitives/Pagination";
import { PageSpinner } from "../../components/primitives/Spinner";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import { Inp, Field } from "../../components/primitives/Form";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

// ─── Constants ────────────────────────────────────────────────────────────────

const LIMIT = 50; // rows per page

// ─── Form (add / edit) ────────────────────────────────────────────────────────

const EntityForm = ({ init = {}, onSave, onCancel }) => {
  // TODO: replace field state with your entity's fields
  const [name, setName] = useState(init.name || "");
  const isEdit = !!init.id;
  const valid  = name.trim().length >= 1;

  const handleSave = () => {
    if (!valid) return;
    // TODO: pass the correct fields to onSave
    onSave({ name: name.trim() });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "4px 0" }}>
      {/* TODO: add fields */}
      <Field label="Name">
        <Inp value={name} onChange={e => setName(e.target.value)} placeholder="Enter name…" autoFocus />
      </Field>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={!valid}>
          {isEdit ? "Save Changes" : "Add"} {/* TODO: entity label */}
        </Btn>
      </div>
    </div>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────

const MdmYourEntityPage = () => { // TODO: rename component
  const [results,  setResults]  = useState([]);
  const [total,    setTotal]    = useState(0);
  const [offset,   setOffset]   = useState(0);
  const [search,   setSearch]   = useState("");
  const [loading,  setLoading]  = useState(true);
  const [modal,    setModal]    = useState(null); // null | "add" | row object
  const [confirm,  setConfirm]  = useState(null); // id to delete
  const timer = useRef(null);

  // TODO: update key + default widths to match your column count
  const { template, startResize } = useResizableColumns("mdm-your-entity", [200, 160, 100, 40]);
  // TODO: last header must be "" — ActionMenu column has no label, or use "Actions"
  const headers = ["Name", "Code", "Status", "Actions"]; // TODO: replace

  const th = {
    position: "relative", paddingLeft: 6,
    fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em",
  };

  // ── Data loading ────────────────────────────────────────────────────────────

  const load = useCallback(async (opts = {}) => {
    const s   = opts.search !== undefined ? opts.search : search;
    const off = opts.offset !== undefined ? opts.offset : offset;
    setLoading(true);
    try {
      // TODO: replace with your api call; must return { results, total }
      const r = await api.yourEntity.list({ search: s, limit: LIMIT, offset: off });
      setResults(r.results || r);
      setTotal(r.total ?? (r.results || r).length);
    } catch { setResults([]); setTotal(0); }
    setLoading(false);
  }, [search, offset]);

  useEffect(() => { load({ search: "", offset: 0 }); }, []);

  const handleSearch = v => {
    setSearch(v);
    setOffset(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: v, offset: 0 }), 300);
  };

  const goPage = off => { setOffset(off); load({ offset: off }); };

  // ── CRUD handlers ───────────────────────────────────────────────────────────

  const handleSave = async (data, isEdit) => {
    try {
      if (isEdit) {
        // TODO: use correct id field
        await api.yourEntity.update(modal.id, data);
      } else {
        await api.yourEntity.create(data);
      }
      setModal(null);
      load();
    } catch (e) {
      // toast.error(e.message); — uncomment if toast is imported
    }
  };

  const handleDelete = async id => {
    try {
      await api.yourEntity.remove(id);
      setConfirm(null);
      load();
    } catch {}
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Page header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>
            Your Entity {/* TODO: page title */}
          </h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total} entr{total !== 1 ? "ies" : "y"} {/* TODO: subtitle / description */}
          </p>
        </div>
        <Btn size="lg" onClick={() => setModal("add")}>＋ Add {/* TODO */}</Btn>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 14 }}>
        <input
          value={search}
          onChange={e => handleSearch(e.target.value)}
          placeholder="Search…" // TODO: placeholder
          style={{ fontFamily: T.body, fontSize: 14, color: T.text, background: T.bg,
            border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 14px",
            outline: "none", maxWidth: 380, width: "100%" }} />
      </div>

      {/* Table */}
      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>

        {/* Column headers */}
        <div style={{ display: "grid", gridTemplateColumns: template,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {headers.map((h, i) => (
            <div key={i} style={th}>
              {h}
              {i < headers.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
            </div>
          ))}
        </div>

        {/* Rows */}
        {loading ? (
          <div style={{ padding: 48 }}><PageSpinner /></div>
        ) : results.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted,
            fontFamily: T.body, fontSize: 14, fontStyle: "italic" }}>
            {search ? "No results match your search." : "No entries yet. Add your first one above."}
          </div>
        ) : results.map(row => (
          <div key={row.id} // TODO: use correct key field
            style={{ display: "grid", gridTemplateColumns: template,
              padding: "12px 20px", borderBottom: `1px solid ${T.border}22`,
              alignItems: "center", transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>

            {/* TODO: replace with your fields */}
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600 }}>
              {row.name}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
              {row.code || "—"}
            </span>
            <div>
              <Badge variant="default">{row.status || "—"}</Badge>
            </div>

            {/* Actions — keep last, always justify flex-end */}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                { icon: "✎", label: "Edit",   onClick: () => setModal(row) },
                // { icon: "📋", label: "History", onClick: () => {} }, // optional
                { icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(row.id) },
              ]} />
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {total > LIMIT && (
        <div style={{ marginTop: 16 }}>
          <Pagination total={total} limit={LIMIT} offset={offset} onPage={goPage} />
        </div>
      )}

      {/* Add modal */}
      {modal === "add" && (
        <Modal title="Add …" onClose={() => setModal(null)} width={480}> {/* TODO */}
          <EntityForm
            onSave={data => handleSave(data, false)}
            onCancel={() => setModal(null)} />
        </Modal>
      )}

      {/* Edit modal */}
      {modal && modal !== "add" && (
        <Modal title="Edit …" onClose={() => setModal(null)} width={480}> {/* TODO */}
          <EntityForm
            init={modal}
            onSave={data => handleSave(data, true)}
            onCancel={() => setModal(null)} />
        </Modal>
      )}

      {/* Delete confirmation */}
      {confirm && (
        <ConfirmModal
          message={`Delete this entry? This cannot be undone.`} // TODO: friendlier message
          onConfirm={() => handleDelete(confirm)}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default MdmYourEntityPage;

/*
 * ─── App.jsx wiring checklist ─────────────────────────────────────────────────
 *
 * 1. Import:
 *      import MdmYourEntityPage from "./pages/mdm/MdmYourEntityPage";
 *
 * 2. PAGE_TITLES (if needed):
 *      "mdm-your-entity": "Master Data — Your Entity",
 *
 * 3. PAGE_SETTING_MAP (if this page is gated by an API toggle):
 *      "mdm-your-entity": "api_xxx_enabled",
 *
 * 4. MDM_PAGES array — add "mdm-your-entity"
 *
 * 5. NavBtn in the sidebar (inside the relevant section):
 *      <NavBtn pageKey="mdm-your-entity" icon="…" label="Your Entity" indent />
 *
 * 6. Route in the main content area:
 *      {page === "mdm-your-entity" && isEnabled("mdm-your-entity") && <MdmYourEntityPage />}
 *
 * ─── server.js checklist ──────────────────────────────────────────────────────
 *
 * 1. Table in schema (CREATE TABLE IF NOT EXISTS your_entities …)
 * 2. mapYourEntity() mapper function
 * 3. GET    /api/your-entities          — list with search + limit + offset
 * 4. GET    /api/your-entities/:id      — single record
 * 5. POST   /api/your-entities          — create
 * 6. PUT    /api/your-entities/:id      — update
 * 7. DELETE /api/your-entities/:id      — delete
 *
 * ─── api.js checklist ─────────────────────────────────────────────────────────
 *
 *   yourEntity: {
 *     list:   (p = {}) => req("GET",    `/your-entities?${new URLSearchParams(p)}`),
 *     get:    (id)     => req("GET",    `/your-entities/${id}`),
 *     create: (data)   => req("POST",   "/your-entities", data),
 *     update: (id, d)  => req("PUT",    `/your-entities/${id}`, d),
 *     remove: (id)     => req("DELETE", `/your-entities/${id}`),
 *   },
 */
