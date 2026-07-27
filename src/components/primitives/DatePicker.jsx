import { useState, useEffect, useRef } from "react";
import { T, MONTHS_LONG, DAYS_SHORT, parseIso, toIso, todayIso } from "../../tokens";
import { Field } from "./Form";
import { inputBase } from "./Form";

// ─── DatePicker ───────────────────────────────────────────────────────────────
// Three-level navigation: Days → Months → Years (click the header to go up).
// Controlled: value = ISO "YYYY-MM-DD" or "". minDate/maxDate also ISO strings.
//
// withTime: value becomes "YYYY-MM-DDTHH:mm" — the calendar itself still operates
// on just the date part (datePart below) so parseIso/cellIso/etc. are untouched;
// a native <input type="time"> row (rendered whenever the popover is open, not
// just on the days view) supplies/edits the time part. Picking a day combines it
// with the current time part (defaulting to DEFAULT_TIME the first time) and
// still closes the popover, same one-click UX as date-only — reopening lets the
// time be adjusted independently without re-picking the date.

const DEFAULT_TIME = "09:00";

const fmtIso = iso => {
  if (!iso) return "";
  const d = parseIso(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

const isoYM  = (y, m) => `${y}-${String(m + 1).padStart(2, "0")}`;
const isoYMD = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const YEARS_PER_PAGE = 12; // 3 × 4 grid

const DatePicker = ({
  id, value = "", onChange,
  minDate, maxDate,
  label, hint, placeholder,
  disabled = false, required = false,
  withTime = false,
}) => {
  const today = todayIso();
  const datePart = value ? value.slice(0, 10) : "";
  const timePart = withTime && value.length > 10 ? value.slice(11, 16) : "";
  const init  = datePart ? parseIso(datePart) : new Date();

  const [open,      setOpen]      = useState(false);
  const [openUp,    setOpenUp]    = useState(false);
  const [dropStyle, setDropStyle] = useState({});
  const triggerRef  = useRef(null);
  const dropRef     = useRef(null);
  const [view,      setView]      = useState("days");   // "days" | "months" | "years"
  const [viewYear,  setViewYear]  = useState(init.getFullYear());
  const [viewMonth, setViewMonth] = useState(init.getMonth());
  const [yearBase,  setYearBase]  = useState(() => Math.floor(init.getFullYear() / YEARS_PER_PAGE) * YEARS_PER_PAGE);
  const ref = useRef(null);

  // position: fixed off the trigger's own viewport rect — same fix PortCombobox/
  // CarrierCombobox already use (CLAUDE.md: "always position: fixed... to escape modal
  // overflow:auto"). DatePicker was never updated to match, so its popover used to be
  // position:absolute (relative to the nearest positioned ancestor) — fine standing alone,
  // but a real bug the first time one landed inside an overflow:auto/hidden container (the
  // per-container plan table's horizontal scroller, LoadingServicePage.jsx): the popover
  // got clipped to that container's own box instead of floating over the whole page.
  const POPOVER_WIDTH = 272;
  const positionPopover = () => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const flipUp = spaceBelow < 340;
    setOpenUp(flipUp);
    // Fixed calendar width regardless of the trigger's own width (a narrow table-cell
    // trigger shouldn't squeeze the day grid) — but still anchored to the trigger
    // horizontally, right-aligning instead of left- when it would overflow the viewport.
    const overflowsRight = r.left + POPOVER_WIDTH > window.innerWidth;
    setDropStyle({
      position: "fixed", zIndex: 9000,
      ...(overflowsRight ? { right: window.innerWidth - r.right } : { left: r.left }),
      ...(flipUp ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
    });
  };

  useEffect(() => {
    if (!open) return;
    positionPopover();
    const update = () => positionPopover();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync view when the date part changes externally
  useEffect(() => {
    if (datePart) {
      const d = parseIso(datePart);
      setViewYear(d.getFullYear()); setViewMonth(d.getMonth());
      setYearBase(Math.floor(d.getFullYear() / YEARS_PER_PAGE) * YEARS_PER_PAGE);
    }
  }, [datePart]);

  // Close on outside click
  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setView("days"); } };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const openPicker = () => {
    if (disabled) return;
    setView("days");
    setOpen(o => !o); // positioning itself is handled by the open-triggered effect above
  };
  const close      = ()  => { setOpen(false); setView("days"); };
  const pick       = iso => {
    onChange(withTime ? `${iso}T${timePart || DEFAULT_TIME}` : iso);
    close();
  };
  const pickTime   = t => { if (datePart) onChange(`${datePart}T${t}`); };
  const clear      = ()  => { onChange(""); close(); };

  // ── Navigation helpers ──────────────────────────────────────────────────────
  const prevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else setViewMonth(m => m - 1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewMonth(0);  setViewYear(y => y + 1); } else setViewMonth(m => m + 1); };

  // ── Days grid ───────────────────────────────────────────────────────────────
  const buildGrid = () => {
    const firstDow = new Date(viewYear, viewMonth, 1).getDay();
    const offset   = firstDow === 0 ? 6 : firstDow - 1;
    const daysInM  = new Date(viewYear, viewMonth + 1, 0).getDate();
    const prevDays = new Date(viewYear, viewMonth, 0).getDate();
    const cells    = [];
    for (let i = offset - 1; i >= 0; i--)
      cells.push({ d: prevDays - i, m: viewMonth - 1, y: viewMonth === 0 ? viewYear - 1 : viewYear, outside: true });
    for (let d = 1; d <= daysInM; d++)
      cells.push({ d, m: viewMonth, y: viewYear, outside: false });
    while (cells.length < 42)
      cells.push({ d: cells.length - offset - daysInM + 1, m: viewMonth + 1, y: viewMonth === 11 ? viewYear + 1 : viewYear, outside: true });
    return cells;
  };

  const cellIso    = c => isoYMD(c.y, c.m, c.d);
  const isDisabled = c => c.outside || (minDate && cellIso(c) < minDate) || (maxDate && cellIso(c) > maxDate);

  // ── Month grid helpers ──────────────────────────────────────────────────────
  const monthDisabled = mIdx => {
    const lastDay  = new Date(viewYear, mIdx + 1, 0).getDate();
    const endOfMon = isoYMD(viewYear, mIdx, lastDay);
    const startMon = isoYMD(viewYear, mIdx, 1);
    if (minDate && endOfMon < minDate) return true;
    if (maxDate && startMon > maxDate) return true;
    return false;
  };
  const monthIsActive = mIdx => datePart && parseIso(datePart).getFullYear() === viewYear && parseIso(datePart).getMonth() === mIdx;
  const monthIsCurrent = mIdx => {
    const t = new Date(); return t.getFullYear() === viewYear && t.getMonth() === mIdx;
  };

  const selectMonth = mIdx => { setViewMonth(mIdx); setView("days"); };

  // ── Year grid helpers ───────────────────────────────────────────────────────
  const yearDisabled = y => {
    if (minDate && y < parseInt(minDate.slice(0, 4))) return true;
    if (maxDate && y > parseInt(maxDate.slice(0, 4))) return true;
    return false;
  };
  const yearIsActive  = y => datePart && parseInt(datePart.slice(0, 4)) === y;
  const yearIsCurrent = y => new Date().getFullYear() === y;

  const selectYear = y => { setViewYear(y); setYearBase(Math.floor(y / YEARS_PER_PAGE) * YEARS_PER_PAGE); setView("months"); };

  // ── Shared styles ───────────────────────────────────────────────────────────
  // Position (fixed, off the trigger's rect) comes from dropStyle/positionPopover above —
  // this is just the fixed cosmetic part, width overridden by dropStyle to match the trigger.
  const popover = {
    background: T.surface, border: `1px solid ${T.borderMid || T.border}`,
    borderRadius: 12, boxShadow: "0 20px 50px rgba(0,0,0,.7)",
    padding: "14px 12px", width: 272,
  };

  const navBtn = (onClick, label) => (
    <button type="button" onClick={onClick}
      style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
        color: T.textMuted, cursor: "pointer", fontSize: 14, padding: "2px 10px",
        fontFamily: T.mono, lineHeight: 1.4 }}>
      {label}
    </button>
  );

  const headerBtn = (label, onClick) => (
    <button type="button" onClick={onClick}
      style={{ background: "none", border: "none", cursor: "pointer",
        fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text,
        padding: "2px 6px", borderRadius: 5, transition: "background .1s" }}
      onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      {label}
    </button>
  );

  const gridCell = ({ cellKey, label, isSelected, isCurrent, isDisabled, onClick, wide }) => (
    <button key={cellKey} type="button" disabled={isDisabled} onClick={onClick}
      style={{
        width: "100%", aspectRatio: wide ? "auto" : "1",
        padding: wide ? "8px 4px" : undefined,
        border: isCurrent && !isSelected ? `1px solid ${T.accent}55` : "1px solid transparent",
        borderRadius: 6, cursor: isDisabled ? "default" : "pointer",
        background: isSelected ? T.accent : "transparent",
        color: isSelected ? (T.btnPrimaryText || "#fff") : isDisabled ? T.border : isCurrent ? T.accent : T.text,
        fontFamily: T.mono, fontSize: wide ? 12 : 11.5,
        fontWeight: isSelected || isCurrent ? 700 : 400,
        textDecoration: isCurrent && !isSelected ? "underline" : "none",
        transition: "background .1s",
      }}
      onMouseEnter={e => { if (!isDisabled && !isSelected) e.currentTarget.style.background = T.surfaceHover; }}
      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}>
      {label}
    </button>
  );

  const cells = buildGrid();

  return (
    <Field label={label} hint={hint} required={required}>
      <div id={id} ref={ref} style={{ position: "relative" }}>

        {/* Trigger */}
        <button type="button" ref={triggerRef} disabled={disabled} onClick={openPicker}
          style={{
            ...inputBase, display: "flex", alignItems: "center", justifyContent: "space-between",
            cursor: disabled ? "not-allowed" : "pointer",
            fontFamily: datePart ? T.mono : T.body, fontSize: 13,
            color: datePart ? T.text : T.border, opacity: disabled ? 0.45 : 1,
            border: open ? `1px solid ${T.accent}` : inputBase.border, transition: "border-color .12s",
          }}>
          <span>{datePart ? `${fmtIso(datePart)}${withTime && timePart ? ` · ${timePart}` : ""}` : (placeholder || (withTime ? "Select date & time…" : "Select date…"))}</span>
          <span style={{ color: T.textMuted, fontSize: 13 }}>▾</span>
        </button>

        {/* Popover */}
        {open && !disabled && (
          <div ref={dropRef} style={{ ...popover, ...dropStyle }}>

            {withTime && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12,
                paddingBottom: 12, borderBottom: `1px solid ${T.border}` }}>
                <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, flexShrink: 0 }}>Time</span>
                <input type="time" value={timePart} disabled={!datePart}
                  onChange={e => pickTime(e.target.value)}
                  style={{ ...inputBase, flex: 1, fontFamily: T.mono, fontSize: 12.5, padding: "5px 8px",
                    opacity: datePart ? 1 : 0.45, cursor: datePart ? "text" : "not-allowed" }} />
              </div>
            )}

            {/* ── DAYS VIEW ── */}
            {view === "days" && (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  {navBtn(prevMonth, "‹")}
                  <div style={{ display: "flex", gap: 2 }}>
                    {headerBtn(MONTHS_LONG[viewMonth], () => setView("months"))}
                    {headerBtn(String(viewYear),       () => setView("years"))}
                  </div>
                  {navBtn(nextMonth, "›")}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 4 }}>
                  {DAYS_SHORT.map(d => (
                    <div key={d} style={{ textAlign: "center", fontFamily: T.mono, fontSize: 9.5,
                      color: T.textMuted, fontWeight: 700, textTransform: "uppercase", padding: "2px 0" }}>{d}</div>
                  ))}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
                  {cells.map((cell, i) => {
                    const iso = cellIso(cell);
                    return gridCell({
                      cellKey: iso || i, label: cell.d,
                      isSelected:  iso === datePart,
                      isCurrent:   iso === today && !cell.outside,
                      isDisabled:  isDisabled(cell),
                      onClick:     () => { if (!isDisabled(cell)) pick(iso); },
                    });
                  })}
                </div>

                <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                  <button type="button"
                    disabled={!!(minDate && today < minDate) || !!(maxDate && today > maxDate)}
                    onClick={() => { if ((!minDate || today >= minDate) && (!maxDate || today <= maxDate)) pick(today); }}
                    style={{ flex: 1, padding: "5px 0", background: "none",
                      border: `1px solid ${T.border}`, borderRadius: 6,
                      color: T.textMuted, fontFamily: T.body, fontSize: 11.5, cursor: "pointer" }}>
                    Today
                  </button>
                  {datePart && (
                    <button type="button" onClick={clear}
                      style={{ flex: 1, padding: "5px 0", background: "none",
                        border: `1px solid ${T.border}`, borderRadius: 6,
                        color: T.danger, fontFamily: T.body, fontSize: 11.5, cursor: "pointer" }}>
                      Clear
                    </button>
                  )}
                </div>
              </>
            )}

            {/* ── MONTHS VIEW ── */}
            {view === "months" && (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                  {navBtn(() => setViewYear(y => y - 1), "‹")}
                  {headerBtn(String(viewYear), () => setView("years"))}
                  {navBtn(() => setViewYear(y => y + 1), "›")}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
                  {MONTHS_LONG.map((name, mIdx) => gridCell({
                    cellKey: mIdx, label: name.slice(0, 3), wide: true,
                    isSelected:  monthIsActive(mIdx),
                    isCurrent:   monthIsCurrent(mIdx),
                    isDisabled:  monthDisabled(mIdx),
                    onClick:     () => { if (!monthDisabled(mIdx)) selectMonth(mIdx); },
                  }))}
                </div>

                <button type="button" onClick={() => setView("days")}
                  style={{ marginTop: 10, width: "100%", padding: "5px 0", background: "none",
                    border: `1px solid ${T.border}`, borderRadius: 6, color: T.textMuted,
                    fontFamily: T.body, fontSize: 11.5, cursor: "pointer" }}>
                  ← Back to days
                </button>
              </>
            )}

            {/* ── YEARS VIEW ── */}
            {view === "years" && (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                  {navBtn(() => setYearBase(b => b - YEARS_PER_PAGE), "‹")}
                  <span style={{ fontFamily: T.head, fontSize: 13, fontWeight: 700, color: T.text }}>
                    {yearBase} – {yearBase + YEARS_PER_PAGE - 1}
                  </span>
                  {navBtn(() => setYearBase(b => b + YEARS_PER_PAGE), "›")}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
                  {Array.from({ length: YEARS_PER_PAGE }, (_, i) => yearBase + i).map(y => gridCell({
                    cellKey: y, label: y, wide: true,
                    isSelected:  yearIsActive(y),
                    isCurrent:   yearIsCurrent(y),
                    isDisabled:  yearDisabled(y),
                    onClick:     () => { if (!yearDisabled(y)) selectYear(y); },
                  }))}
                </div>

                <button type="button" onClick={() => setView("months")}
                  style={{ marginTop: 10, width: "100%", padding: "5px 0", background: "none",
                    border: `1px solid ${T.border}`, borderRadius: 6, color: T.textMuted,
                    fontFamily: T.body, fontSize: 11.5, cursor: "pointer" }}>
                  ← Back to months
                </button>
              </>
            )}

          </div>
        )}
      </div>
    </Field>
  );
};

export default DatePicker;