import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { T, teuOf } from "../../tokens";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import { ContainerForm } from "./ShipmentDetailPage";
import ContainerEventsPanel from "../../components/shared/ContainerEventsPanel";
import { NavRow, PackageDetailForm } from "../../components/shared/ContainerPackagesPanel";
import { fmtCurr } from "../../utils/invoiceGenerator";
import { emitCargoValueChanged } from "../../cargoValueBus";
import { api } from "../../api";
import { toast } from "../../toast";
import { setNavigationGuard, clearNavigationGuard } from "../../navigationGuard";
import { dgPolicyConflict } from "../../utils/dgPolicy";
import { IconWarning, IconClipboard, IconPackage, IconArchive, IconClose } from "../../components/primitives/Icon";

// ─── Shipment Containers Page — unified Containers + Cargo Manifest tree ──────
// Cargo Manifest & Container Details Redesign (TKT-OTKNJN), direct user-drawn concept:
// replaces the old flat container table + a separate "Cargo Manifest" modal-per-
// container with one page — a left tree spanning every container (root nodes) fanning
// out into each one's typed pack breakdown (container_packages, however deep/wide the
// operator configures it — not fixed to one pallet), and a right detail panel whose
// content depends on what's selected: a container shows its full ContainerForm plus
// a Marks & Nos. field and a read-only Description of Goods rollup of its own pack
// items; a pallet/carton shows the pack detail form (type/description/quantity/DG).

const PackageTreeNode = ({ pkg, allPackages, containerId, depth, navOpen, onToggle, selection, onSelect, packTypeById }) => {
  const children = allPackages.filter(p => p.parentId === pkg.id);
  const isOpen = navOpen[pkg.id] !== false;
  const type = pkg.packTypeId ? packTypeById[pkg.packTypeId] : null;
  const selected = selection?.kind === "package" && selection.id === pkg.id;
  return (
    <div>
      <NavRow id={`pkgnode-${pkg.id}`} icon={type?.icon || IconPackage} label={pkg.description} badge={pkg.quantity}
        dgClass={pkg.isDg ? pkg.dgClass : null}
        depth={depth} selected={selected}
        onClick={() => onSelect({ kind: "package", containerId, id: pkg.id })}
        onToggle={children.length > 0 ? () => onToggle(pkg.id) : null}
        hasChildren={children.length > 0} isOpen={isOpen} />
      {isOpen && children.map(child => (
        <PackageTreeNode key={child.id} pkg={child} allPackages={allPackages} containerId={containerId} depth={depth + 1}
          navOpen={navOpen} onToggle={onToggle} selection={selection} onSelect={onSelect} packTypeById={packTypeById} />
      ))}
    </div>
  );
};

const ShipmentContainersPage = ({ shipment, containers, onBack, onAddContainer, onEditContainer, onDeleteContainer }) => {
  const { canEditShipments: canEdit } = useAuth();
  const ctrs     = containers.filter(c => c.shipmentId === shipment.id);
  const totalTEU = ctrs.reduce((sum, c) => sum + teuOf(c.size), 0);

  const [packagesByCtr, setPackagesByCtr] = useState({}); // { [containerId]: Package[] }
  const [packTypes,     setPackTypes]     = useState([]);
  const [navOpen,       setNavOpen]       = useState({});
  const [selection,     setSelection]     = useState(null);
  // null | {kind:"container",id} | {kind:"new-container"} | {kind:"package",containerId,id} | {kind:"new-package",containerId,parentId}
  const [saving,        setSaving]        = useState(false);
  const [eventsCtr,      setEventsCtr]     = useState(null);
  const [confirmCtr,     setConfirmCtr]    = useState(null);
  const [dgPolicy,       setDgPolicy]      = useState(null);
  const ctrFormRef = useRef(null);

  const loadPackages = useCallback(() => {
    Promise.all(ctrs.map(c => api.containerPackages.list(c.id).then(pkgs => [c.id, pkgs]).catch(() => [c.id, []])))
      .then(entries => setPackagesByCtr(Object.fromEntries(entries)));
  }, [ctrs.map(c => c.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadPackages(); }, [loadPackages]);
  useEffect(() => { api.packTypes.list().then(setPackTypes).catch(() => setPackTypes([])); }, []);

  const packTypeById = useMemo(() => Object.fromEntries(packTypes.map(t => [t.id, t])), [packTypes]);
  const toggleNav = id => setNavOpen(p => ({ ...p, [id]: p[id] === false }));

  useEffect(() => {
    if (!shipment.contractId) { setDgPolicy(null); return; }
    api.contracts.get(shipment.contractId)
      .then(c => setDgPolicy({ dgAllowed: c.dgAllowed, imdgClasses: c.imdgClasses || [] }))
      .catch(() => setDgPolicy(null));
  }, [shipment.contractId]);

  // Navigation guard (TKT-OJYO71): while a container is selected (equivalent to the old
  // Add/Edit Container modal being open), attempting to switch sections auto-validates +
  // auto-saves via ContainerForm's own imperative trySave() instead of silently discarding
  // an in-progress edit — only blocks (with the concrete field-level reason) if validation
  // actually fails.
  useEffect(() => {
    if (selection?.kind !== "container" && selection?.kind !== "new-container") { clearNavigationGuard(); return; }
    setNavigationGuard({
      trySave: async () => {
        if (!ctrFormRef.current) return { ok: true };
        return ctrFormRef.current.trySave();
      },
    });
    return () => clearNavigationGuard();
  }, [selection]);

  const ctrDgConflict = c => dgPolicyConflict(dgPolicy, c.isDg, c.dgClass);
  const dgConflicts = ctrs.filter(ctrDgConflict).length;

  // Auto-select a freshly-added container once it lands in the containers prop —
  // handleAddContainer (App.jsx) appends to the end of the array, so the newest one
  // is always last.
  const prevCtrCountRef = useRef(ctrs.length);
  useEffect(() => {
    if (selection?.kind === "new-container" && ctrs.length > prevCtrCountRef.current) {
      setSelection({ kind: "container", id: ctrs[ctrs.length - 1].id });
    }
    prevCtrCountRef.current = ctrs.length;
  }, [ctrs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedCtr = selection?.kind === "container" ? ctrs.find(c => c.id === selection.id) || null : null;
  const selectedPkg = selection?.kind === "package"
    ? (packagesByCtr[selection.containerId] || []).find(p => p.id === selection.id) || null
    : null;

  const handleSaveContainer = async form => {
    try {
      if (selection?.kind === "new-container") {
        await onAddContainer(shipment.id, form);
      } else if (selectedCtr) {
        await onEditContainer(selectedCtr.id, form);
      }
    } catch { /* error already toasted by App.jsx handler */ }
  };

  const handleSavePackage = async data => {
    setSaving(true);
    try {
      if (selection?.kind === "new-package") {
        const created = await api.containerPackages.create(selection.containerId, { ...data, parentId: selection.parentId });
        loadPackages();
        setSelection({ kind: "package", containerId: selection.containerId, id: created.id });
        toast.success("Package added");
      } else if (selection?.kind === "package") {
        await api.containerPackages.update(selection.id, data);
        loadPackages();
        toast.success("Package updated");
      }
      // ShipmentHeaderBar is persistent (mounted once, never remounts on navigation) so its
      // own Cargo Value rollup only refetches when the shipment's container ids change —
      // signal it directly so a priced/repriced item is reflected immediately (TKT-NSTDKF).
      emitCargoValueChanged(shipment.id);
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const handleDeletePackage = async () => {
    if (!selectedPkg) return;
    try {
      await api.containerPackages.remove(selectedPkg.id);
      setSelection(null);
      loadPackages();
      toast.success("Package deleted");
      emitCargoValueChanged(shipment.id);
    } catch (e) { toast.error(e.message); }
  };

  // Description of Goods — every pack item under this container, any depth, flattened
  // into one itemized list (not just top-level) so it reads as a real manifest at a
  // glance without needing to drill into the tree.
  const descriptionOfGoods = useMemo(() => {
    if (!selectedCtr) return [];
    return [...(packagesByCtr[selectedCtr.id] || [])].sort((a, b) => a.position - b.position);
  }, [selectedCtr, packagesByCtr]);

  // Cargo value rollup (Epic TKT-P3ASH1, Story TKT-NSTDKF) — sum of quantity x unitValueUsd
  // over every priced item in the same flat list above (same flattening, not a second rule;
  // a priced parent AND priced children double-count, same modeling ambiguity the existing
  // quantity rollup already accepts against an arbitrary-depth tree).
  const cargoValueRollup = useMemo(() => {
    const priced = descriptionOfGoods.filter(p => p.unitValueUsd != null);
    return {
      totalUsd: priced.reduce((s, p) => s + p.unitValueUsd * p.quantity, 0),
      pricedCount: priced.length, totalCount: descriptionOfGoods.length,
    };
  }, [descriptionOfGoods]);

  // The owning container of a selected/new pack item — selectedCtr is null in that case
  // (its own derivation only matches selection.kind === "container"), so resolve via
  // selection.containerId instead, to thread the container's own HS code into the pack
  // item form as a placeholder default (Epic TKT-P3ASH1).
  const activePkgContainer = (selection?.kind === "package" || selection?.kind === "new-package")
    ? ctrs.find(c => c.id === selection.containerId) || null : null;

  return (
    <div id="shpctr-page" style={{ maxWidth: 1200, margin: "0 auto" }}>
      {/* Toolbar */}
      <div id="shpctr-toolbar" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span id="shpctr-summary" style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
            {ctrs.length} container{ctrs.length !== 1 ? "s" : ""} · {totalTEU} TEU total
          </span>
          {dgConflicts > 0 && (
            <span id="shpctr-dg-conflicts" style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.warning,
              background: T.warning + "18", border: `1px solid ${T.warning}55`,
              borderRadius: 6, padding: "2px 8px", display: "inline-flex", alignItems: "center", gap: 5 }}>
              <IconWarning size={11} />{dgConflicts} DG conflict{dgConflicts !== 1 ? "s" : ""} — review required
            </span>
          )}
        </div>
      </div>

      {ctrs.length === 0 && !canEdit ? (
        <div id="shpctr-empty" style={{ padding: 48, textAlign: "center", fontFamily: T.body,
          fontSize: 13, color: T.textMuted, fontStyle: "italic",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10 }}>
          No containers yet.
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "flex-start", border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
          {/* Left: container + cargo manifest tree — capped height with its own scroll (only
              kicks in once there are enough containers/packages to need it) so a long tree
              never pushes the page's real height around; the right panel below is NOT capped,
              so its content (and the Save/Cancel and Add Package buttons at the end of it)
              flows naturally in the page instead of being buried inside a second nested
              scroll box — a real bug found live: those buttons were unreachable-looking,
              stuck deep inside a small fixed-height (560px) scrollable panel. */}
          <div style={{ width: 260, flexShrink: 0, maxHeight: 640, background: T.bg, borderRight: `1px solid ${T.border}`,
            display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "10px 10px 8px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
              <span style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 700, letterSpacing: ".07em",
                textTransform: "uppercase", color: T.textMuted }}>Containers</span>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 4px" }}>
              {ctrs.length === 0 ? (
                <div style={{ padding: "16px 10px", fontFamily: T.body, fontSize: 11.5,
                  color: T.textMuted, fontStyle: "italic", lineHeight: 1.5 }}>
                  No containers yet — add one below.
                </div>
              ) : ctrs.map(c => {
                const pkgs = packagesByCtr[c.id] || [];
                const roots = pkgs.filter(p => !p.parentId);
                const isOpen = navOpen[c.id] !== false;
                return (
                  <div key={c.id}>
                    <NavRow id={`shpctr-${c.id}-row`} icon={IconArchive}
                      label={`${c.containerNumber || c.id} · ${c.size}ft ${c.type}`}
                      badge={`${teuOf(c.size)} TEU`}
                      dgClass={c.isDg ? c.dgClass : null}
                      depth={0} selected={selection?.kind === "container" && selection.id === c.id}
                      onClick={() => setSelection({ kind: "container", id: c.id })}
                      onToggle={roots.length > 0 ? () => toggleNav(c.id) : null}
                      hasChildren={roots.length > 0} isOpen={isOpen} />
                    {isOpen && roots.map(pkg => (
                      <PackageTreeNode key={pkg.id} pkg={pkg} allPackages={pkgs} containerId={c.id} depth={1}
                        navOpen={navOpen} onToggle={toggleNav} selection={selection} onSelect={setSelection} packTypeById={packTypeById} />
                    ))}
                  </div>
                );
              })}
            </div>
            {canEdit && (
              <button id="shpctr-add-btn" type="button" onClick={() => setSelection({ kind: "new-container" })}
                style={{ margin: 8, padding: "7px 12px", background: "none", border: `1px dashed ${T.accent}55`,
                  borderRadius: 6, cursor: "pointer", fontFamily: T.body, fontSize: 12, color: T.accent }}>
                ＋ Add Container
              </button>
            )}
          </div>

          {/* Right: detail — no internal scroll; flows naturally in the page so its own
              action buttons (ContainerForm's Save/Cancel, Add Package) are always reachable
              by scrolling the page, not hidden inside a small nested scroll box. */}
          <div style={{ flex: 1, minWidth: 0, minHeight: 400, padding: 20 }}>
            {selection?.kind === "new-container" ? (
              <>
                <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: "0 0 16px" }}>Add Container</h3>
                <ContainerForm ref={ctrFormRef} init={{}} dgPolicy={dgPolicy}
                  onSave={handleSaveContainer} onCancel={() => setSelection(null)} />
              </>
            ) : selectedCtr ? (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>
                    {selectedCtr.containerNumber || selectedCtr.id}
                  </h3>
                  <div style={{ display: "flex", gap: 6 }}>
                    <Btn id={`shpctr-${selectedCtr.id}-events-btn`} size="sm" variant="secondary" onClick={() => setEventsCtr(selectedCtr)}
                      title={selectedCtr.latestEventType ? `Latest: ${selectedCtr.latestEventType}${selectedCtr.latestEventLocation ? ` @ ${selectedCtr.latestEventLocation}` : ""} (${selectedCtr.latestEventAt || ""})` : "No lifecycle events yet"}>
                      <IconClipboard size={12} /> Lifecycle Events
                    </Btn>
                    {canEdit && (
                      <Btn id={`shpctr-${selectedCtr.id}-delete-btn`} size="sm" variant="danger" onClick={() => setConfirmCtr(selectedCtr.id)}>
                        <IconClose size={11} /> Delete
                      </Btn>
                    )}
                  </div>
                </div>
                <ContainerForm ref={ctrFormRef} key={selectedCtr.id} init={selectedCtr} dgPolicy={dgPolicy}
                  onSave={handleSaveContainer} onCancel={() => setSelection(null)} />

                <div style={{ marginTop: 24 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 700, letterSpacing: ".07em",
                        textTransform: "uppercase", color: T.textMuted }}>Description of Goods</div>
                      {cargoValueRollup.pricedCount > 0 && (
                        <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.accent,
                          background: T.accent + "18", border: `1px solid ${T.accent}55`, borderRadius: 5, padding: "2px 8px" }}>
                          {fmtCurr(cargoValueRollup.totalUsd, "USD")}
                          {cargoValueRollup.pricedCount < cargoValueRollup.totalCount
                            ? ` · ${cargoValueRollup.pricedCount}/${cargoValueRollup.totalCount} priced` : ""}
                        </span>
                      )}
                    </div>
                    {canEdit && (
                      <Btn id="shpctr-add-package-btn" size="sm" variant="secondary"
                        onClick={() => setSelection({ kind: "new-package", containerId: selectedCtr.id, parentId: null })}>
                        ＋ Add Package
                      </Btn>
                    )}
                  </div>
                  {descriptionOfGoods.length === 0 ? (
                    <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, fontStyle: "italic" }}>
                      No packing breakdown recorded yet — add pallets/cartons on the left.
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {descriptionOfGoods.map((p, i) => (
                        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8,
                          padding: "6px 10px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6 }}>
                          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, flexShrink: 0 }}>Item {i + 1}</span>
                          <span style={{ flex: 1, fontFamily: T.body, fontSize: 12.5, color: T.text }}>{p.description}</span>
                          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, fontWeight: 700, flexShrink: 0 }}>× {p.quantity}</span>
                          {p.unitValueUsd != null && (
                            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, flexShrink: 0 }}>
                              {fmtCurr(p.unitValue, p.currency || "USD")}
                            </span>
                          )}
                          {p.isDg && p.dgClass && (
                            <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700, color: "#fff",
                              background: T.danger, borderRadius: 4, padding: "1px 5px", flexShrink: 0 }}>DG {p.dgClass}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : selection?.kind === "new-package" ? (
              <PackageDetailForm isNew packTypes={packTypes} canEdit={canEdit} saving={saving}
                containerHsCode={activePkgContainer?.hsCode}
                init={{ packTypeId: null }} onSave={handleSavePackage} onCancel={() => setSelection(null)} />
            ) : selectedPkg ? (
              <PackageDetailForm key={selectedPkg.id} packTypes={packTypes} canEdit={canEdit} saving={saving}
                containerHsCode={activePkgContainer?.hsCode}
                init={selectedPkg} onSave={handleSavePackage} onDelete={handleDeletePackage}
                onAddChild={() => setSelection({ kind: "new-package", containerId: selection.containerId, parentId: selectedPkg.id })} />
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%",
                textAlign: "center", fontFamily: T.body, fontSize: 12.5, color: T.textMuted, fontStyle: "italic" }}>
                Select a container or a pack item on the left, or add a container to get started.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Lifecycle events */}
      {eventsCtr && (
        <Modal title={`Lifecycle Events — ${eventsCtr.containerNumber || eventsCtr.id}`}
          onClose={() => setEventsCtr(null)} width={480}>
          <ContainerEventsPanel containerId={eventsCtr.id} containerNumber={eventsCtr.containerNumber} />
        </Modal>
      )}

      {/* Delete confirm */}
      {confirmCtr && (
        <ConfirmModal
          message="Remove this container from the shipment?"
          onConfirm={() => { onDeleteContainer(confirmCtr); setConfirmCtr(null); setSelection(null); }}
          onCancel={() => setConfirmCtr(null)} />
      )}
    </div>
  );
};

export default ShipmentContainersPage;
