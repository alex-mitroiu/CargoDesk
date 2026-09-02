import { useState } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import { DOC_TYPES, docTypeLabel, getMissingDocRequirements, dispatchDocBuilder } from "../../utils/documentBuilders";
import { renderTemplateHtml } from "../../utils/templateRenderer";

const GenerateDocumentModal = ({ shipment, onClose, onSaved, defaultCode }) => {
  const defaultNum = `${shipment.id}-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const [docCode,  setDocCode]  = useState(defaultCode || DOC_TYPES[0].code);
  const [docNum,   setDocNum]   = useState(defaultNum);
  const [docDate,  setDocDate]  = useState(new Date().toISOString().slice(0, 10));
  const [notes,    setNotes]    = useState("");
  const [loading,  setLoading]  = useState(false);

  const handlePreview = async () => {
    setLoading(true);
    try {
      const needsCostLines = docCode === "FR01" || docCode === "FR02";
      const needsDgSettings = docCode === "DG01";
      // ITN (TKT-6A7J45 story 1) — only House/Master B/L carry it, no reason to fetch
      // customs filings for every other document type.
      const needsExportFiling = docCode === "BL01" || docCode === "MB01" || docCode === "BR01";
      // Rate snapshot reference — BR01 only, mirrors the same "latest snapshot for this
      // shipment" lookup the real EDI booking-request payload already does server-side.
      // costLineRead-gated on the backend (finance-visibility), so a viewer without that
      // access simply gets no rate reference on the document rather than a failed generation.
      const needsRateSnapshot = docCode === "BR01";
      const [ctrsRaw, shipper, consignee, costLines, orgSettings, parties, filings, rateSnapshots] = await Promise.all([
        api.containers.list(),
        shipment.shipperId   ? api.customers.get(shipment.shipperId).catch(() => null)   : Promise.resolve(null),
        shipment.consigneeId ? api.customers.get(shipment.consigneeId).catch(() => null) : Promise.resolve(null),
        needsCostLines ? api.costLines.list(shipment.id).then(ls => ls.filter(l => l.type === "SELL")) : Promise.resolve([]),
        needsDgSettings ? api.settings.get().catch(() => null) : Promise.resolve(null),
        api.shipmentParties.list(shipment.id).catch(() => []),
        needsExportFiling ? api.customsFilings.list(shipment.id).catch(() => []) : Promise.resolve([]),
        needsRateSnapshot ? api.costLines.rateSnapshots(shipment.id).catch(() => []) : Promise.resolve([]),
      ]);
      const rateSnapshotId = rateSnapshots[0]?.id || null;
      const exportFilingItn = filings.find(f => f.filingType === "AES_EEI" && f.status === "Accepted")?.confirmationNumber || null;
      const allCtrs         = Array.isArray(ctrsRaw) ? ctrsRaw : (ctrsRaw?.results ?? []);
      const containersBase  = allCtrs.filter(c => c.shipmentId === shipment.id);
      // Structured cargo line items (Epic TKT-P3ASH1, Story TKT-LUNODU) — only CI01/CI02/PL01
      // render per-pack-item rows; every other doc type is left untouched (no extra requests)
      // since container_packages has no bulk "packages for a whole shipment" endpoint.
      const needsPackages = docCode === "CI01" || docCode === "CI02" || docCode === "PL01";
      const containers = needsPackages
        ? await Promise.all(containersBase.map(async c => ({ ...c, packages: await api.containerPackages.list(c.id).catch(() => []) })))
        : containersBase;
      // Org-wide DG compliance address (TKT-DPLQTV) — pulled onto the DG01 declaration's
      // emergency-contact line in place of a hand-filled blank; falls back to the generic
      // CHEMTREC/CANUTEC hotlines if the org hasn't filled its own compliance address in yet.
      const dgCompliance = orgSettings ? {
        contactName: orgSettings.dg_compliance_contact_name || "",
        phone:       orgSettings.dg_compliance_phone         || "",
        email:       orgSettings.dg_compliance_email         || "",
        address:     orgSettings.dg_compliance_address       || "",
      } : null;
      // Document Template Editor — an office+carrier-scoped custom layout, BL01 pilot only.
      // A match renders through the saved template instead of the hardcoded builder and skips
      // getMissingDocRequirements entirely (the template's own placed fields ARE the
      // requirements — an unbound source just renders blank, no hard gate). No match falls
      // through to today's exact behavior, unchanged.
      const template = docCode === "BL01"
        ? await api.documentTemplates.resolve(docCode, shipment.emoOfficeId || "", shipment.carrierCode || "").catch(() => null)
        : null;

      const dataBag = {
        shipment, invNumber: docNum, invDate: docDate, notes, containers, shipper, consignee, costLines, dgCompliance, parties, exportFilingItn, rateSnapshotId,
      };

      let html;
      if (template) {
        html = renderTemplateHtml(template, dataBag);
      } else {
        const missing = getMissingDocRequirements(docCode, { shipment, containers, shipper, consignee, costLines, dgCompliance, parties });
        if (missing.length > 0) {
          toast.error(`Cannot generate ${docTypeLabel(docCode)} — missing:\n${missing.map(m => `• ${m}`).join("\n")}`);
          setLoading(false);
          return;
        }
        html = dispatchDocBuilder(docCode, dataBag);
      }

      // Save to shipment documents — server renders + signs the PDF, so the signing key
      // never has to leave the server.
      const filename = `${docCode}-${docNum}-${docDate}.pdf`;
      const saved    = await api.documents.generate(shipment.id, {
        html, filename, docType: docCode,
      });
      toast.success(`${docTypeLabel(docCode)} saved to Documents`);
      onSaved?.(saved);
    } catch (ex) { toast.error(ex.message); }
    setLoading(false);
  };

  return (
    <Modal title="Generate Document" onClose={onClose} width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 6 }}>Document Type</div>
          <select value={docCode} onChange={e => setDocCode(e.target.value)}
            style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", cursor: "pointer" }}>
            {/* CN01 is excluded — it's only ever produced by the Reverse action on Invoice Entry,
                never picked ad hoc (it needs real reversal-line data behind it). */}
            {DOC_TYPES.filter(t => t.code !== "CN01").map(t => <option key={t.code} value={t.code}>{t.code} · {t.label}</option>)}
          </select>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Reference Number</div>
            <input value={docNum} onChange={e => setDocNum(e.target.value)}
              style={{ width: "100%", fontFamily: T.mono, fontSize: 12, background: T.surface, color: T.text,
                border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px" }} />
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Date</div>
            <input type="date" value={docDate} onChange={e => setDocDate(e.target.value)}
              style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
                border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px" }} />
          </div>
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Notes (optional)</div>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            placeholder="Additional notes to appear on the document…"
            style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", resize: "vertical", boxSizing: "border-box" }} />
        </div>
        <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
          Generates a digitally signed PDF and saves it to Documents.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={handlePreview} disabled={loading || !docNum.trim()}>
            {loading ? "Building…" : "Generate →"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
};

export default GenerateDocumentModal;
