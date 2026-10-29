// Browser-side PPTX → Markdown. Slides are XML inside a zip, so text,
// tables and equations can be read directly — no OCR or server needed.
import { NS, attr, kid, kids, omml, openZip, readXml, rels, tableOut } from "./ooxml.js";

function runText(p) {
  let s = "";
  for (const c of p.children) {
    if (c.namespaceURI === NS.a && (c.localName === "r" || c.localName === "fld")) s += kid(c, "a", "t")?.textContent ?? "";
    else if (c.namespaceURI === NS.a && c.localName === "br") s += " ";
    else if (c.namespaceURI === NS.m && c.localName === "oMath") s += ` $${omml(c).trim()}$ `;
    else for (const m of c.getElementsByTagNameNS(NS.m, "oMath")) s += ` $${omml(m).trim()}$ `;
  }
  return s.replace(/\s+/g, " ").trim();
}

function paragraphs(txBody, bulleted) {
  const out = [];
  for (const p of kids(txBody, "a", "p")) {
    const text = runText(p);
    if (!text) continue;
    const pPr = kid(p, "a", "pPr");
    const lvl = Number(attr(pPr, "lvl") || 0);
    out.push(bulleted && !kid(pPr, "a", "buNone") ? `${"  ".repeat(lvl)}- ${text}` : text);
  }
  return out;
}

// PPTX keeps placeholder cells for merges (hMerge/vMerge), so fill them from their origin.
function table(tbl) {
  const grid = [], cells = [];
  kids(tbl, "a", "tr").forEach((tr, r) => {
    grid[r] = [];
    cells[r] = [];
    kids(tr, "a", "tc").forEach((tc, c) => {
      if (tc.hasAttribute("hMerge")) grid[r][c] = grid[r][c - 1];
      else if (tc.hasAttribute("vMerge")) grid[r][c] = grid[r - 1]?.[c];
      else {
        const body = kid(tc, "a", "txBody");
        grid[r][c] = body ? paragraphs(body, false).join(" ") : "";
        cells[r].push({ text: grid[r][c], cs: Number(attr(tc, "gridSpan")) || 1, rs: Number(attr(tc, "rowSpan")) || 1 });
      }
    });
  });
  return tableOut(grid, cells);
}

function placeholderType(sp) {
  const nv = kid(sp, "p", "nvSpPr");
  const ph = nv && kid(kid(nv, "p", "nvPr") ?? nv, "p", "ph");
  return ph ? ph.getAttribute("type") || "body" : null;
}

function walk(tree, acc) {
  for (const el of tree.children) {
    if (el.namespaceURI !== NS.p) continue;
    if (el.localName === "sp") {
      const type = placeholderType(el);
      const body = kid(el, "p", "txBody");
      if (!body) continue;
      if (type === "title" || type === "ctrTitle") {
        const t = paragraphs(body, false).join(" ");
        if (t) acc.title ??= t;
        continue;
      }
      acc.blocks.push(paragraphs(body, type === "body" || type === "obj").join("\n"));
    } else if (el.localName === "grpSp") {
      walk(el, acc);
    } else if (el.localName === "graphicFrame") {
      const tbl = el.getElementsByTagNameNS(NS.a, "tbl")[0];
      if (tbl) acc.blocks.push(table(tbl));
    }
  }
}

async function notesText(zip, slideRels) {
  const note = Object.values(slideRels).find((r) => r.type.endsWith("/notesSlide"));
  const doc = note && (await readXml(zip, note.target));
  if (!doc) return "";
  const lines = [];
  for (const sp of doc.getElementsByTagNameNS(NS.p, "sp")) {
    if (placeholderType(sp) !== "body") continue;
    const body = kid(sp, "p", "txBody");
    if (body) lines.push(...paragraphs(body, false));
  }
  return lines.join(" ");
}

export async function pptxToMarkdown(file, onProgress) {
  const zip = await openZip(file);
  const presPath = "ppt/presentation.xml";
  const pres = await readXml(zip, presPath);
  if (!pres) throw new Error("not_pptx");
  const presRels = await rels(zip, presPath);
  const ids = [...pres.getElementsByTagNameNS(NS.p, "sldId")].map((s) => s.getAttributeNS(NS.r, "id"));

  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const path = presRels[ids[i]]?.target;
    const doc = path && (await readXml(zip, path));
    if (!doc) continue;
    const tree = doc.getElementsByTagNameNS(NS.p, "spTree")[0];
    const acc = { title: null, blocks: [] };
    if (tree) walk(tree, acc);
    out.push(`<!-- page ${i + 1} -->`);
    out.push(`## ${acc.title ?? `Slide ${i + 1}`}`);
    out.push(...acc.blocks.filter(Boolean));
    const notes = await notesText(zip, await rels(zip, path));
    if (notes) out.push(`> Notes: ${notes}`);
    onProgress?.((i + 1) / ids.length);
  }
  return out.join("\n\n") + "\n";
}
