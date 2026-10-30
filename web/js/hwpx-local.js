// Browser-side HWPX (Hangul 2014+ default format) → Markdown. Like DOCX it is XML in a zip:
// Contents/header.xml holds paragraph shapes (outline levels = headings, numbering, bullets),
// Contents/sectionN.xml the body, in the order Contents/content.hpf lists. Running headers and
// footers are left out; tables, equations, text boxes and notes are read.
import { openZip, readXml, tableOut } from "./ooxml.js";
import { hwpEquation } from "./hwp-eq.js";

// Element names are matched without namespaces: Hangul versions use 2011 and 2016 URIs.
const named = (el, name) => [...el.children].filter((c) => c.localName === name);
const first = (el, name) => el && [...el.getElementsByTagName("*")].find((c) => c.localName === name);
const SKIP = new Set(["secPr", "header", "footer", "pageNum", "pageHiding", "pageNumCtrl", "newNum", "autoNum", "bookmark", "indexmark", "hiddenComment", "fieldBegin", "fieldEnd", "linesegarray", "colPr"]);
const FIGURE = new Set(["pic", "ole", "chart", "video"]);

// paraPr id → { kind: "OUTLINE" | "NUMBER" | "BULLET" | "NONE", level }
function paraShapes(header) {
  const shapes = new Map();
  if (!header) return shapes;
  for (const p of header.getElementsByTagName("*")) {
    if (p.localName !== "paraPr") continue;
    const h = first(p, "heading");
    if (h) shapes.set(p.getAttribute("id"), { kind: h.getAttribute("type"), level: Number(h.getAttribute("level")) || 0 });
  }
  return shapes;
}

function makeReader(shapes) {
  const notes = [];

  const paragraphs = (container) => named(container, "p").map(paragraph).filter(Boolean);
  // The outermost text lists under an element; lists nested in them are read by their own table or box.
  const subLists = (el, out = []) => {
    for (const c of el.children) c.localName === "subList" ? out.push(c) : subLists(c, out);
    return out;
  };

  function paragraph(p) {
    let s = "";
    const blocks = [];
    for (const run of named(p, "run")) {
      for (const el of run.children) {
        const name = el.localName;
        if (name === "t") s += text(el);
        else if (SKIP.has(name)) continue;
        else if (name === "tbl") blocks.push(table(el));
        else if (name === "equation") {
          const script = first(el, "script")?.textContent.trim();
          if (script) s += ` $${hwpEquation(script)}$ `;
        } else if (name === "ctrl") {
          for (const c of el.children) {
            if (c.localName !== "footNote" && c.localName !== "endNote") continue;
            const body = subLists(c).flatMap(paragraphs).join(" ");
            if (body) { notes.push(body); s += `[^${notes.length}]`; }
          }
        } else blocks.push(shape(el));
      }
    }
    const textLine = s.replace(/\s+/g, " ").trim();
    const shapeOf = shapes.get(p.getAttribute("paraPrIDRef"));
    let line = textLine;
    if (textLine && shapeOf?.kind === "OUTLINE") line = `${"#".repeat(Math.min(6, shapeOf.level + 1))} ${textLine}`;
    else if (textLine && (shapeOf?.kind === "NUMBER" || shapeOf?.kind === "BULLET")) line = `${"  ".repeat(shapeOf.level)}- ${textLine}`;
    return [line, ...blocks].filter(Boolean).join("\n\n");
  }

  function text(t) {
    let s = "";
    for (const n of t.childNodes) {
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.localName === "hyphen") s += "-";
      else if (["tab", "lineBreak", "fwSpace", "nbSpace"].includes(n.localName)) s += " ";
      else if (n.nodeType === 1 && !/^(insert|delete|markpen)/.test(n.localName)) s += n.textContent;
    }
    return s;
  }

  // Drawing objects and the like: a picture leaves a marker, a text box keeps its text.
  function shape(el) {
    const figure = FIGURE.has(el.localName) || [...el.getElementsByTagName("*")].some((c) => FIGURE.has(c.localName));
    const inner = subLists(el).flatMap(paragraphs).join("\n\n");
    const art = el.localName === "textart" ? el.getAttribute("text") || "" : "";
    return [figure ? "<!-- figure -->" : "", art, inner].filter(Boolean).join("\n\n");
  }

  function table(tbl) {
    const rows = Number(tbl.getAttribute("rowCnt")) || named(tbl, "tr").length;
    const cols = Number(tbl.getAttribute("colCnt")) || Math.max(0, ...named(tbl, "tr").map((tr) => named(tr, "tc").length));
    const grid = Array.from({ length: rows }, () => Array(cols).fill(""));
    const cells = Array.from({ length: rows }, () => []);
    named(tbl, "tr").forEach((tr, r) => {
      named(tr, "tc").forEach((tc, i) => {
        const addr = named(tc, "cellAddr")[0], span = named(tc, "cellSpan")[0];
        const col = Number(addr?.getAttribute("colAddr") ?? i), row = Number(addr?.getAttribute("rowAddr") ?? r);
        const cs = Math.max(1, Number(span?.getAttribute("colSpan")) || 1), rs = Math.max(1, Number(span?.getAttribute("rowSpan")) || 1);
        const list = named(tc, "subList")[0];
        const content = list ? paragraphs(list).join(" ").replace(/\n+/g, " ") : "";
        if (row >= rows || col >= cols) return;
        cells[row].push({ col, text: content, cs, rs });
        for (let y = row; y < Math.min(rows, row + rs); y++)
          for (let x = col; x < Math.min(cols, col + cs); x++) grid[y][x] = content;
      });
    });
    // A one-cell table is a box around text (a cover title, a note), not data; an empty one is layout.
    if (rows * cols === 1) return grid[0][0];
    if (grid.every((row) => row.every((c) => !c))) return "";
    for (const row of cells) row.sort((a, b) => a.col - b.col);
    return tableOut(grid, cells);
  }

  return { paragraphs, notes };
}

// Section files in reading order: the package spine, else by number.
async function sectionPaths(zip) {
  const hpf = await readXml(zip, "Contents/content.hpf");
  if (hpf) {
    const items = new Map([...hpf.getElementsByTagName("*")].filter((e) => e.localName === "item").map((e) => [e.getAttribute("id"), e.getAttribute("href")]));
    const spine = [...hpf.getElementsByTagName("*")].filter((e) => e.localName === "itemref").map((e) => items.get(e.getAttribute("idref")))
      .filter((h) => h && /section\d+\.xml$/i.test(h)).map((h) => (h.startsWith("Contents/") ? h : `Contents/${h}`));
    if (spine.length && spine.every((p) => zip.file(p))) return spine;
  }
  return Object.keys(zip.files).filter((p) => /^Contents\/section\d+\.xml$/i.test(p)).sort((a, b) => a.match(/(\d+)\.xml/)[1] - b.match(/(\d+)\.xml/)[1]);
}

export async function hwpxToMarkdown(file, onProgress) {
  const zip = await openZip(file);
  const manifest = await zip.file("META-INF/manifest.xml")?.async("string");
  if (manifest?.includes("encryption-data")) throw new Error("hwp_distribution");
  const sections = await sectionPaths(zip);
  if (!sections.length) throw new Error("not_hwpx");
  const reader = makeReader(paraShapes(await readXml(zip, "Contents/header.xml")));
  const out = [];
  for (const [i, path] of sections.entries()) {
    const doc = await readXml(zip, path);
    if (doc?.documentElement) for (const p of reader.paragraphs(doc.documentElement)) out.push(p);
    onProgress?.((i + 1) / sections.length);
  }
  if (reader.notes.length) out.push(reader.notes.map((n, i) => `[^${i + 1}]: ${n}`).join("\n"));
  return out.join("\n\n").replace(/^(\s*- .*)\n\n(?=\s*- )/gm, "$1\n") + "\n";
}
