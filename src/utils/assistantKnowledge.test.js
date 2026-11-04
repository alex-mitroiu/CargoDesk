// @vitest-environment node
// The AI Assistant's knowledge file (data/assistant-knowledge.json) is built from the User Manual and
// DFS.md by scripts/build-assistant-knowledge.mjs. This fails while the committed file is out of date,
// so a manual change can't reach users without the assistant learning it too:
//   npm run build:assistant-knowledge
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildKnowledge, serialize, OUTPUT } from "../../scripts/build-assistant-knowledge.mjs";
import { manualAnchor } from "./manualAnchors";

describe("assistant knowledge file", () => {
  const built = buildKnowledge();

  it("is up to date with the User Manual and DFS.md", () => {
    const committed = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8").replace(/\r\n/g, "\n") : "";
    expect(committed, "data/assistant-knowledge.json is stale — run npm run build:assistant-knowledge").toBe(serialize(built));
  });

  it("covers every manual section and the functional spec", () => {
    const sections = new Set(built.chunks.filter(c => c.source === "User Manual").map(c => c.section));
    for (const s of ["welcome", "booking", "documents", "money", "si-vgm", "dg-classes", "incoterms"]) expect(sections.has(s)).toBe(true);
    expect(built.chunks.some(c => c.source === "Functional Spec" && c.section === "dfs-5-12")).toBe(true);
  });

  it("keeps passages a searchable size and never ships shell commands", () => {
    for (const c of built.chunks) {
      expect(c.text.split(/\s+/).length).toBeLessThanOrEqual(420);
      expect(c.text).not.toMatch(/irm https?:|curl -fsSL/);
    }
  });

  it("gives each manual passage the anchor the page uses for its heading", () => {
    const step = built.chunks.find(c => c.source === "User Manual" && /^Step \d+: /.test(c.heading));
    expect(step.anchor).toBe(manualAnchor(step.heading.replace(/^Step \d+: /, "").replace(/ \(continued\)$/, "")));
  });
});

describe("manualAnchor", () => {
  it("makes a stable slug", () => {
    expect(manualAnchor("The House B/L panel")).toBe("the-house-b-l-panel");
    expect(manualAnchor("What you'll see if you're not ready yet")).toBe("what-you-ll-see-if-you-re-not-ready-yet");
    expect(manualAnchor("Incoterms® 2020")).toBe("incoterms-2020");
  });
});
