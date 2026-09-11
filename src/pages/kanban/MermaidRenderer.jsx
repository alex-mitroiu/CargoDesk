import { useState, useEffect, useRef } from "react";
import mermaid from "mermaid";
import { T } from "../../tokens";

// ─── Mermaid Renderer ─────────────────────────────────────────────────────────
// Renders a Mermaid diagram definition to SVG client-side.
// Each instance uses a unique ID so concurrent renders don't collide.
// Re-mounts (via key) when the definition changes to avoid stale SVG.

const MermaidRenderer = ({ definition }) => {
  const [svg,   setSvg]   = useState("");
  const [error, setError] = useState(null);
  // Unique stable ID for this renderer instance
  const diagId = useRef(`mcd-${Math.random().toString(36).slice(2, 9)}`);

  useEffect(() => {
    let cancelled = false;
    setSvg("");
    setError(null);

    mermaid.initialize({
      startOnLoad: false,
      theme:       "dark",
      flowchart:   { curve: "basis", padding: 24, nodeSpacing: 48, rankSpacing: 64 },
      securityLevel: "loose",   // needed to allow <br/> in node labels
    });

    mermaid.render(diagId.current, definition)
      .then(({ svg: out }) => { if (!cancelled) setSvg(out); })
      .catch(e            => { if (!cancelled) setError(String(e)); });

    return () => { cancelled = true; };
  }, [definition]);

  if (error) return (
    <div style={{ padding: 20, fontFamily: T.mono, fontSize: 12, color: T.danger,
      background: `${T.danger}11`, borderRadius: 8, margin: 16 }}>
      ⚠ Diagram render error — check the definition syntax.<br />
      <span style={{ opacity: 0.7, fontSize: 11 }}>{error}</span>
    </div>
  );

  if (!svg) return (
    <div style={{ padding: 48, textAlign: "center", fontFamily: T.body,
      fontSize: 13, color: T.textMuted }}>
      Rendering diagram…
    </div>
  );

  return (
    <div dangerouslySetInnerHTML={{ __html: svg }}
      style={{ width: "100%", display: "flex", justifyContent: "center" }} />
  );
};

export default MermaidRenderer;
