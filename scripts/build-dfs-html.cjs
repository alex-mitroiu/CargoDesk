// Rebuilds documentation/cargodesk-dfs.html from DFS.md — run `node scripts/build-dfs-html.cjs` from the
// CargoDesk folder after changing DFS.md (first done 2026-10-21). The page's own shell (styles, sidebar,
// theme toggle) is kept; the sidebar contents, header and every section are regenerated; the DFDs are
// rendered with mermaid in headless Chrome and baked in as static SVG, so the copy stays fully offline.
// Chrome: $CHROME_PATH, else the newest one in puppeteer's cache (~/.cache/puppeteer/chrome). `marked`
// comes with mermaid (a dependency of it), puppeteer-core and mermaid are the project's own.
const fs = require("fs"), path = require("path"), os = require("os");
const { createRequire } = require("module");
const req = createRequire(path.join(process.cwd(), "package.json"));
const { marked } = req("marked");
const puppeteer = req("puppeteer-core");

const PROFILE = path.join(os.tmpdir(), "cargodesk-dfs-chrome");
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
  const builds = fs.existsSync(root) ? fs.readdirSync(root).sort().reverse() : [];
  for (const b of builds) for (const rel of ["chrome-win64/chrome.exe", "chrome-linux64/chrome", "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]) {
    const p = path.join(root, b, rel);
    if (fs.existsSync(p)) return p;
  }
  throw new Error("No Chrome found: set CHROME_PATH, or run `npx puppeteer browsers install chrome`");
}
const md = fs.readFileSync("DFS.md", "utf8").replace(/\r\n/g, "\n");
const old = fs.readFileSync("documentation/cargodesk-dfs.html", "utf8");
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = s => marked.parseInline(s);

(async () => {
  const lines = md.split("\n");
  const intro = lines.slice(1, lines.indexOf("---")).join("\n").trim();
  const body = lines.slice(lines.findIndex(l => /^## 1\. /.test(l))).join("\n");

  // ─── Diagrams ──────────────────────────────────────────────────────────────────────────────
  const diagrams = [];
  const withMarks = body.replace(/```mermaid\n([\s\S]*?)```/g, (_, code) => { diagrams.push(code); return `\n<!--DIAGRAM${diagrams.length - 1}-->\n`; });
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, userDataDir: PROFILE });
  const svgs = [];
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: req.resolve("mermaid/dist/mermaid.min.js") });
    for (const [i, code] of diagrams.entries()) {
      const src = code.replace(/\\n/g, "<br/>");
      svgs.push(await page.evaluate(async (src, id) => {
        mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "loose", flowchart: { htmlLabels: true, useMaxWidth: true } });
        return (await mermaid.render(id, src)).svg;
      }, src, `dfd${i + 1}`));
    }
  } finally { await browser.close(); }
  // A light sheet inside the card, so the neutral-theme drawing reads on the dark theme too.
  // A drawing wider than the text column keeps its own size and the card scrolls sideways: shrunk to
  // fit, the Level 1 diagram's labels fell to a few pixels.
  const natural = svg => {
    const w = Number((svg.match(/viewBox="[\d.-]+ [\d.-]+ ([\d.]+)/) || [])[1]) || 0;
    return w > 1100 ? svg.replace(/width="100%"/, `width="${Math.round(w)}"`).replace(/max-width:\s*[\d.]+px;?/, "max-width:none;") : svg;
  };
  const diagramCard = i => `<div class="diagram-card"><div class="mermaid-diagram" style="background:#fff;border-radius:8px;padding:12px;width:max-content;min-width:100%">${natural(svgs[i])}</div></div>`;

  // ─── Sections ──────────────────────────────────────────────────────────────────────────────
  const fixLinks = html => html
    .replace(/href="documentation\/([^"]+)"/g, 'href="$1"')
    .replace(/href="([A-Z][A-Za-z0-9_-]*\.md)"/g, 'href="../$1"');
  const render = (chunk, domain) => {
    let text = chunk.trim();
    if (domain) text = text.replace(/\n(\*\*(?:Purpose|Key functions|Roles|Primary data|Business rules)\*\*)/g, "\n\n$1");
    let html = marked.parse(text);
    html = html.replace(/<!--DIAGRAM(\d+)-->/g, (_, i) => diagramCard(Number(i)));
    html = html.replace(/<p><strong>Reading this diagram<\/strong>:([\s\S]*?)<\/p>/g, '<p class="diagram-note"><strong>Reading this diagram</strong> —$1</p>');
    if (domain) {
      html = html.replace(/<p><strong>Business rules<\/strong>:\s*([\s\S]*?)<\/p>/g, '<div class="rules"><b>Rule —</b> $1</div>');
      html = html.replace(/<strong>(Purpose|Key functions|Roles|Primary data)<\/strong>:/g, "<strong>$1</strong> —");
    }
    return fixLinks(html);
  };
  const h2s = [...withMarks.matchAll(/^## (\d+)\. (.+)$/gm)];
  const nav = [];
  let main = "";
  h2s.forEach((m, i) => {
    const n = m[1], title = m[2];
    const content = withMarks.slice(m.index + m[0].length, i + 1 < h2s.length ? h2s[i + 1].index : undefined);
    nav.push(`      <li><a href="#s${n}">${n} · ${inline(title)}</a></li>`);
    const h3s = [...content.matchAll(/^### (\d+)\.(\d+) (.+)$/gm)];
    let sec = `\n    <section id="s${n}">\n      <h2>${n}. ${inline(title)}</h2>\n`;
    sec += render(h3s.length ? content.slice(0, h3s[0].index) : content, false);
    h3s.forEach((h, j) => {
      const sub = `${h[1]}.${h[2]}`, raw = h[3];
      const proc = raw.match(/^(.*?)\s*(\((?:P[\d\w]+(?:\s*\/\s*P[\d\w]+)*)\))$/);
      const name = proc ? proc[1] : raw;
      const chunk = content.slice(h.index + h[0].length, j + 1 < h3s.length ? h3s[j + 1].index : undefined);
      const domain = n === "5";
      sec += `\n      <h3 id="s${h[1]}${h[2]}"><span class="num">${sub}</span>${inline(name)}${proc ? ` <span class="mono" style="color:var(--text-muted);font-size:14px">${esc(proc[2])}</span>` : ""}</h3>\n`;
      sec += domain ? `      <div class="card">\n${render(chunk, true)}      </div>\n` : render(chunk, false);
      if (n === "4" || n === "5") nav.push(`      <li><a href="#s${h[1]}${h[2]}" class="sub">${sub} ${inline(name.replace(/ — .*/, ""))}</a></li>`);
    });
    if (n === "3") sec = sec.replace(/<td><strong>([a-z_]+)<\/strong>/g, '<td><span class="role-badge">$1</span>');
    main += sec + "    </section>\n";
  });

  const updated = (intro.match(/last updated (\d{4}-\d{2}-\d{2})/) || [])[1] || "";
  const header = `
    <div class="doc-header">
      <h1 class="doc-title">Design &amp; Functional Specification</h1>
      <div class="doc-meta"><b>Status</b> First pass, top-down &nbsp;·&nbsp; <b>Last updated</b> ${updated} &nbsp;·&nbsp; <b>Scope</b> Whole application &nbsp;·&nbsp; <b>Companion</b> ARCHITECTURE.md, CLAUDE.md</div>
    </div>
    <div class="doc-intro">${fixLinks(marked.parse(intro))}</div>
`;

  // ─── Assemble into the existing shell ─────────────────────────────────────────────────────
  const tocStart = old.indexOf('<ul class="toc">'), tocEnd = old.indexOf("</ul>", tocStart) + "</ul>".length;
  const mainStart = old.indexOf("<main>") + "<main>".length, mainEnd = old.indexOf("</main>");
  if (tocStart < 0 || mainStart < 6 || mainEnd < 0) throw new Error("The page shell changed: TOC or <main> not found");
  const out = old.slice(0, tocStart) + `<ul class="toc">\n${nav.join("\n")}\n    </ul>` + old.slice(tocEnd, mainStart) + header + main + "  " + old.slice(mainEnd);
  fs.writeFileSync("documentation/cargodesk-dfs.html", out);
  console.log(`written: ${out.length} bytes, ${h2s.length} sections, ${diagrams.length} diagrams, ${nav.length} nav entries`);
})().catch(e => { console.error(e); process.exit(1); });
