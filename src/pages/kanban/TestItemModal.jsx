import { useState } from "react";
import { T } from "../../tokens";
import { inputBase, Inp, Sel, Textarea } from "../../components/primitives/Form";
import Badge from "../../components/primitives/Badge";
import Btn from "../../components/primitives/Btn";
import { IconSearch } from "../../components/primitives/Icon";
import ParentPickerModal from "./ParentPickerModal";
import TestCaseStoryLinksPanel from "../../components/shared/TestCaseStoryLinksPanel";
import { TEST_PARENT_TYPES, TEST_TYPES, TYPE_ICON, TYPE_VARIANT, PRIORITIES, TEST_STATUSES } from "./constants";

// ─── Test Item Modal (Test Folder / Plan / Run / Case) ───────────────────────

const TestItemModal = ({ init = {}, shipments = [], testItems = [], tickets = [], users = [], versions = [], onSave, onCancel }) => {
  const isEdit = !!init.id;
  const [f, setF] = useState({
    title:       init.title       || "",
    type:        init.type        || "Test Case",
    description: init.description || "",
    priority:    init.priority    || "Medium",
    status:      init.status      || "Ready",
    shipmentId:  init.shipmentId  || "",
    versionId:   init.versionId   || "",
    assigneeId:  init.assigneeId  || "",
    dueDate:     init.dueDate     || "",
    parentId:    init.parentId    || "",
    testNotes:   init.testNotes   || "",
  });
  const [showParentPicker, setShowParentPicker] = useState(false);
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  const valid = f.title.trim().length > 0;

  const selectedParent = f.parentId ? testItems.find(t => t.id === f.parentId) : null;
  // Test Folder/Plan are always roots — nesting for those happens only via drag-and-drop
  // in the sidebar, matching the original tickets-based behavior.
  const allowedParentTypes = TEST_PARENT_TYPES[f.type] || null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Inp label="Title" value={f.title} onChange={set("title")} placeholder="e.g. Verify login with valid credentials" required />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Sel label="Type" value={f.type} onChange={set("type")}
          options={TEST_TYPES.map(t => ({ value: t, label: `${TYPE_ICON[t]} ${t}` }))} />
        <Sel label="Priority" value={f.priority} onChange={set("priority")}
          options={PRIORITIES.map(p => ({ value: p, label: p }))} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Sel label="Assignee" value={f.assigneeId} onChange={set("assigneeId")}
          options={[
            { value: "", label: "— Unassigned —" },
            ...users.filter(u => u.isActive !== false).map(u => ({ value: u.id, label: u.name })),
          ]}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
            textTransform: "uppercase", letterSpacing: ".06em" }}>Due Date</label>
          <input type="date" value={f.dueDate} onChange={e => set("dueDate")(e.target.value)}
            style={{ ...inputBase, fontFamily: T.mono, fontSize: 13, cursor: "pointer",
              colorScheme: "dark" }} />
        </div>
      </div>

      {allowedParentTypes && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
            textTransform: "uppercase", letterSpacing: ".06em" }}>
            Parent <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span>
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, minHeight: 36,
              background: T.bg, border: `1px solid ${selectedParent ? T.accent + "66" : T.border}`,
              borderRadius: 7, padding: "6px 12px" }}>
              {selectedParent ? (
                <>
                  <span style={{ fontSize: 15, flexShrink: 0 }}>{TYPE_ICON[selectedParent.type] || "📋"}</span>
                  <Badge variant={TYPE_VARIANT[selectedParent.type] || "default"}>{selectedParent.type}</Badge>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, flexShrink: 0 }}>
                    {selectedParent.id}
                  </span>
                  <span style={{ fontFamily: T.body, fontSize: 12, color: T.text, flex: 1,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {selectedParent.title}
                  </span>
                  <button type="button" onClick={() => set("parentId")("")}
                    style={{ background: "none", border: "none", cursor: "pointer",
                      color: T.textMuted, fontSize: 16, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
                    onMouseEnter={e => e.currentTarget.style.color = T.danger}
                    onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>×</button>
                </>
              ) : (
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.border, fontStyle: "italic",
                  display: "inline-flex", alignItems: "center", gap: 4 }}>
                  None — click <IconSearch size={11} /> to search
                </span>
              )}
            </div>
            <button type="button" onClick={() => setShowParentPicker(true)}
              title={`Search for a parent ${allowedParentTypes.join(" or ")}`}
              style={{ background: T.accentBg, border: `1px solid ${T.accent}55`, borderRadius: 7,
                color: T.accent, cursor: "pointer", fontSize: 16, padding: "6px 12px",
                lineHeight: 1, flexShrink: 0, transition: "background .12s" }}
              onMouseEnter={e => e.currentTarget.style.background = `${T.accent}33`}
              onMouseLeave={e => e.currentTarget.style.background = T.accentBg}>
              <IconSearch size={15} />
            </button>
          </div>
        </div>
      )}

      {showParentPicker && (
        <ParentPickerModal
          tickets={testItems}
          excludeId={init.id}
          onSelect={t => set("parentId")(t.id)}
          onClose={() => setShowParentPicker(false)}
          allowedTypes={allowedParentTypes}
          initialTypeFilter={allowedParentTypes.length === 1 ? allowedParentTypes[0] : ""}
        />
      )}

      <Sel label="Linked Shipment (optional)" value={f.shipmentId} onChange={set("shipmentId")}
        options={[
          { value: "", label: "— None —" },
          ...shipments.map(s => ({ value: s.id, label: `${s.id} · ${s.pol}→${s.pod} · ${s.carrierCode} (${s.status})` })),
        ]}
      />
      {versions.length > 0 && (
        <Sel label="Version (optional)" value={f.versionId} onChange={set("versionId")}
          options={[
            { value: "", label: "— Unversioned —" },
            ...versions.map(v => ({ value: v.id, label: `${v.name}${v.status ? ` · ${v.status}` : ""}${v.releaseDate ? ` · ${v.releaseDate}` : ""}` })),
          ]}
        />
      )}
      <Textarea label="Description" value={f.description} onChange={set("description")}
        placeholder="What is this verifying?" rows={4} />

      {f.type === "Test Case" && (
        <Textarea label="Test Notes / Steps" value={f.testNotes} onChange={set("testNotes")}
          placeholder={"Steps to reproduce or test steps:\n1. Navigate to…\n2. Enter…\n3. Verify that…"} rows={4} />
      )}

      {isEdit && (
        <Sel label="Status" value={f.status} onChange={set("status")}
          options={TEST_STATUSES.map(s => ({ value: s, label: s }))} />
      )}

      {isEdit && f.type === "Test Case" && (
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <TestCaseStoryLinksPanel caseId={init.id} tickets={tickets} />
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn disabled={!valid} onClick={() => onSave(f)}>
          {isEdit ? "Save Changes" : "Create Test Item"}
        </Btn>
      </div>
    </div>
  );
};

export default TestItemModal;
