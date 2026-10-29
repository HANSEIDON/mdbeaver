// Browser-side DOCX → Markdown. Word files are XML inside a zip: headings come
// from paragraph styles, lists from numbering, tables and equations are read directly.
import { NS, gridToMarkdown, kid, kids, omml, openZip, readXml, wval } from "./ooxml.js";

const SKIP = new Set(["delText", "instrText", "rPr", "pPr", "fldChar", "footnoteReference", "endnoteReference"]);

function paraText(p) {
  let s = "";
  const walk = (el) => {
    for (const c of el.children) {
      if (c.namespaceURI === NS.m && (c.localName === "oMath")) { s += ` $${omml(c).trim()}$ `; continue; }
      if (c.namespaceURI !== NS.w) { walk(c); continue; }
      if (SKIP.has(c.localName) || c.localName === "del") continue;
      if (c.localName === "t") s += c.textContent;
      else if (c.localName === "tab" || c.localName === "br" || c.localName === "cr") s += " ";
      else walk(c);
    }
  };
  walk(p);
  return s.replace(/\s+/g, " ").trim();
}

// styleId → heading level (1-6) via outline level or a "heading N"/"title" name, following basedOn.
async function headingLevels(zip) {
  const doc = await readXml(zip, "word/styles.xml");
  const styles = new Map();
  if (!doc) return () => 0;
  for (const s of doc.getElementsByTagNameNS(NS.w, "style")) {
    const id = s.getAttributeNS(NS.w, "styleId") ?? s.getAttribute("w:styleId");
    const name = (wval(kid(s, "w", "name")) || "").toLowerCase();
    const outline = wval(kid(kid(s, "w", "pPr"), "w", "outlineLvl"));
    styles.set(id, { name, outline: outline == null ? null : Number(outline), basedOn: wval(kid(s, "w", "basedOn")) });
  }
  const level = (id, depth = 0) => {
    const s = styles.get(id);
    if (!s || depth > 10) return 0;
    if (s.name === "title") return 1;
    const m = s.name.match(/^heading\s*(\d)$/);
    if (m) return Math.min(6, Number(m[1]));
    if (s.outline != null && s.outline < 9) return Math.min(6, s.outline + 1);
    return s.basedOn ? level(s.basedOn, depth + 1) : 0;
  };
  return level;
}

function paragraph(p, levelOf) {
  const text = paraText(p);
  if (!text) return null;
  const pPr = kid(p, "w", "pPr");
  const outline = wval(kid(pPr, "w", "outlineLvl"));
  const lvl = outline != null && Number(outline) < 9 ? Number(outline) + 1 : levelOf(wval(kid(pPr, "w", "pStyle")));
  if (lvl) return `${"#".repeat(lvl)} ${text}`;
  const numPr = kid(pPr, "w", "numPr");
  if (numPr) return `${"  ".repeat(Number(wval(kid(numPr, "w", "ilvl")) || 0))}- ${text}`;
  return text;
}

// Word stores horizontal merges as gridSpan (one cell) and vertical ones as vMerge chains.
function table(tbl) {
  const grid = [];
  kids(tbl, "w", "tr").forEach((tr, r) => {
    grid[r] = [];
    let col = 0;
    for (const tc of kids(tr, "w", "tc")) {
      const tcPr = kid(tc, "w", "tcPr");
      const span = Number(wval(kid(tcPr, "w", "gridSpan")) || 1);
      const vMerge = kid(tcPr, "w", "vMerge");
      const continued = vMerge && (wval(vMerge) ?? "continue") !== "restart";
      const text = continued ? (grid[r - 1]?.[col] ?? "") : [...tc.getElementsByTagNameNS(NS.w, "p")].map(paraText).filter(Boolean).join(" ");
      for (let i = 0; i < span; i++) grid[r][col++] = text;
    }
  });
  return gridToMarkdown(grid);
}

function blocks(container, levelOf, out) {
  for (const el of container.children) {
    if (el.namespaceURI !== NS.w) continue;
    if (el.localName === "p") {
      const line = paragraph(el, levelOf);
      if (line) out.push(line);
    } else if (el.localName === "tbl") {
      out.push(table(el));
    } else if (el.localName === "sdt") {
      const content = kid(el, "w", "sdtContent");
      if (content) blocks(content, levelOf, out);
    }
  }
}

export async function docxToMarkdown(file, onProgress) {
  const zip = await openZip(file);
  const doc = await readXml(zip, "word/document.xml");
  if (!doc) throw new Error("not_docx");
  const body = doc.getElementsByTagNameNS(NS.w, "body")[0];
  const levelOf = await headingLevels(zip);
  const out = [];
  blocks(body, levelOf, out);
  onProgress?.(1);
  // Consecutive list items read best without blank lines between them.
  return out.join("\n\n").replace(/^(\s*- .*)\n\n(?=\s*- )/gm, "$1\n") + "\n";
}
