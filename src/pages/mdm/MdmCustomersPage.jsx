import { useState, useEffect, useCallback, useRef } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { PageSpinner } from "../../components/primitives/Spinner";
import Btn from "../../components/primitives/Btn";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import Pagination from "../../components/primitives/Pagination";
import { inputBase, Inp, Textarea, Field } from "../../components/primitives/Form";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

// ─── Customer Form ────────────────────────────────────────────────────────────

const CustomerForm = ({ init = {}, onSave, onCancel }) => {
  const isEdit = !!init.id;
  const [f, setF] = useState({
    companyName: init.companyName || "",
    address1:    init.address1    || "",
    address2:    init.address2    || "",
    city:        init.city        || "",
    state:       init.state       || "",
    postalCode:  init.postalCode  || "",
    countryIso2: init.countryIso2 || "",
    phone:       init.phone       || "",
    fax:         init.fax         || "",
    email:       init.email       || "",
    website:     init.website     || "",
    notes:       init.notes       || "",
  });
  const set   = k => v => setF(p => ({ ...p, [k]: v }));
  const valid = f.companyName.trim().length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Inp label="Company Name" value={f.companyName} onChange={set("companyName")}
        placeholder="Acme Freight B.V." required />

      <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.border, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".12em", marginBottom: -6 }}>Address</div>

      <Inp label="Address Line 1" value={f.address1} onChange={set("address1")}
        placeholder="Wilhelminakade 123" />
      <Inp label="Address Line 2" value={f.address2} onChange={set("address2")}
        placeholder="Suite 4B" />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="City"             value={f.city}       onChange={set("city")}       placeholder="Rotterdam" />
        <Inp label="State / Province" value={f.state}      onChange={set("state")}      placeholder="South Holland" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Postal Code"  value={f.postalCode}  onChange={set("postalCode")}  placeholder="3072 AP" mono />
        <Inp label="Country (ISO2)" value={f.countryIso2}
          onChange={v => setF(p => ({ ...p, countryIso2: v.toUpperCase().slice(0, 2) }))}
          placeholder="NL" mono maxLength={2}
          hint="2-letter ISO 3166-1 country code" />
      </div>

      <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.border, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".12em", marginBottom: -6 }}>Contact</div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Phone" value={f.phone} onChange={set("phone")} placeholder="+31 10 123 4567" mono />
        <Inp label="Fax"   value={f.fax}   onChange={set("fax")}   placeholder="+31 10 123 4568" mono />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Email"   value={f.email}   onChange={set("email")}   placeholder="ops@acme-freight.com" />
        <Inp label="Website" value={f.website} onChange={set("website")} placeholder="https://acme-freight.com" />
      </div>

      <Textarea label="Notes" value={f.notes} onChange={set("notes")}
        placeholder="Internal notes, account manager, payment terms…" rows={3} />

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn disabled={!valid} onClick={() => onSave(f)}>
          {isEdit ? "Save Changes" : "Add Customer"}
        </Btn>
      </div>
    </div>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────

const LIMIT = 50;

const MdmCustomersPage = () => {
  const [results, setResults] = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [search,  setSearch]  = useState("");
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null);   // null | "add" | customer obj
  const [confirm, setConfirm] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const res = await api.customers.list({
        search: opts.search !== undefined ? opts.search : search,
        limit:  LIMIT,
        offset: opts.offset !== undefined ? opts.offset : offset,
      });
      setResults(res.results);
      setTotal(res.total);
    } catch {}
    setLoading(false);
  }, [search, offset]);

  useEffect(() => { load(); }, []);

  const handleSearch = v => {
    setSearch(v); setOffset(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: v, offset: 0 }), 300);
  };

  const goPage = off => { setOffset(off); load({ offset: off }); };

  const handleSave = async form => {
    try {
      if (modal === "add") {
        await api.customers.create(form);
      } else {
        await api.customers.update(modal.id, form);
      }
      setModal(null);
      load();
    } catch (e) {
      // surface server errors inside the modal — toast would work too
      alert(e.message);
    }
  };

  const handleDelete = async id => {
    try {
      await api.customers.remove(id);
      setConfirm(null);
      load();
    } catch {}
  };

  // Column header style
  const th = {
    position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em",
  };

  const { template: template, startResize } = useResizableColumns("mdm-customers", [220,160,80,160,160,130]);
  const custHeaders = ["Company","City / Country","Phone","Email","Website",""];
  const COL = template;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>
            Customers
          </h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total} customer{total !== 1 ? "s" : ""} in registry
          </p>
        </div>
        <Btn size="lg" onClick={() => setModal("add")}>＋ Add Customer</Btn>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input
          value={search}
          onChange={e => handleSearch(e.target.value)}
          placeholder="Search company, city, email, phone…"
          style={{ ...inputBase, width: 320 }}
        />
      </div>

      {/* Table */}
      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>

        {/* Column headers */}
        <div style={{ display: "grid", gridTemplateColumns: COL,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}`, gap: 0 }}>
          {custHeaders.map((h, i) => (
            <div key={i} style={th}>{h}{i < custHeaders.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}</div>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 48 }}><PageSpinner /></div>
        ) : results.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted,
            fontFamily: T.body, fontSize: 14, fontStyle: "italic" }}>
            {search ? "No customers match your search." : "No customers yet. Add your first one above."}
          </div>
        ) : results.map(c => (
          <div key={c.id}
            style={{ display: "grid", gridTemplateColumns: COL,
              padding: "13px 20px", borderBottom: `1px solid ${T.border}22`,
              alignItems: "center", gap: 0 }}>

            {/* Company */}
            <div>
              <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text }}>
                {c.companyName}
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, marginTop: 2 }}>
                {c.id}
              </div>
            </div>

            {/* City / Country */}
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
              {[c.city, c.countryIso2].filter(Boolean).join(" · ") || "—"}
            </div>

            {/* Phone */}
            <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>
              {c.phone || <span style={{ color: T.border }}>—</span>}
            </div>

            {/* Email */}
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.text,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {c.email
                ? <a href={`mailto:${c.email}`} style={{ color: T.accent, textDecoration: "none" }}
                    onClick={e => e.stopPropagation()}>{c.email}</a>
                : <span style={{ color: T.border }}>—</span>}
            </div>

            {/* Website */}
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {c.website || <span style={{ color: T.border }}>—</span>}
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <Btn size="sm" variant="secondary" onClick={() => setModal(c)}>Edit</Btn>
              <Btn size="sm" variant="danger"    onClick={() => setConfirm(c.id)}>✕</Btn>
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

      {/* Add / Edit modal */}
      {modal && (
        <Modal
          title={modal === "add" ? "Add Customer" : `Edit — ${modal.companyName}`}
          onClose={() => setModal(null)}
          width={560}
        >
          <CustomerForm
            init={modal === "add" ? {} : modal}
            onSave={handleSave}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {/* Delete confirm */}
      {confirm && (
        <ConfirmModal
          message={`Remove this customer? This cannot be undone.`}
          onConfirm={() => handleDelete(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
};

export default MdmCustomersPage;
