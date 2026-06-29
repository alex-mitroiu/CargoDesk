import { useState } from "react";
import { T } from "../../tokens";

const MIN_COL = 30;

export const useResizableColumns = (storageKey, defaults) => {
  const load = () => {
    try {
      const s = localStorage.getItem(`colwidths:${storageKey}`);
      if (s) {
        const p = JSON.parse(s);
        if (Array.isArray(p) && p.length === defaults.length) return p;
      }
    } catch {}
    return defaults;
  };

  const [widths, setWidths] = useState(load);

  const persist = ws => {
    setWidths(ws);
    try { localStorage.setItem(`colwidths:${storageKey}`, JSON.stringify(ws)); } catch {}
  };

  const startResize = (colIndex, e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX  = e.clientX;
    const startW  = widths[colIndex];
    const origWidths = [...widths];
    document.body.style.userSelect = "none";
    document.body.style.cursor     = "col-resize";

    const onMove = mv => {
      const ws = [...origWidths];
      ws[colIndex] = Math.max(MIN_COL, startW + (mv.clientX - startX));
      setWidths(ws);
    };
    const onUp = mv => {
      const ws = [...origWidths];
      ws[colIndex] = Math.max(MIN_COL, startW + (mv.clientX - startX));
      persist(ws);
      document.body.style.userSelect = "";
      document.body.style.cursor     = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  };

  const template = widths.map(w => `${w}px`).join(" ");
  const reset    = () => persist(defaults);

  return { widths, template, startResize, reset };
};

// Drag handle rendered at the right edge of a header cell (all but last column)
export const ColResizer = ({ onStart }) => (
  <div
    onMouseDown={onStart}
    title="Drag to resize column"
    style={{
      position: "absolute", right: -2, top: 0, bottom: 0,
      width: 5, cursor: "col-resize", zIndex: 2,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}
    onMouseEnter={e => e.currentTarget.querySelector("div").style.background = T.accent}
    onMouseLeave={e => e.currentTarget.querySelector("div").style.background = "transparent"}
  >
    <div style={{
      width: 1, height: "60%", background: "transparent",
      borderRadius: 1, transition: "background .15s",
      pointerEvents: "none",
    }} />
  </div>
);
