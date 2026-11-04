// User Manual heading anchors. The manual page gives each heading this id, and the AI Assistant's
// knowledge file (scripts/build-assistant-knowledge.mjs) records the same one with every passage, so a
// source the assistant cites opens the manual at that heading (#manual/<section>/<anchor>). Both sides
// must call this one function: a second slug rule would make links that land nowhere.

export function manualAnchor(text) {
  return String(text ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}
