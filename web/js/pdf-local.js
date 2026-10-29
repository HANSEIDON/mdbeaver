// Browser-side PDF → Markdown fallback. Reads the text layer only:
// headings are guessed from font size, paragraphs from vertical gaps.
import * as pdfjs from "/vendor/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";

const MAX_PAGES = 2000;
// Body of a page with no (usable) text layer; app.js looks for it to send those pages to the GPU.
export const SCANNED_PAGE = "_(no text layer — scanned page, needs OCR)_";
// Appended to pages that have text but a layout the browser can only guess (columns, big tables);
// app.js sends them to the GPU too and output.js drops the marker.
export const NEEDS_GPU = "<!-- needs-gpu -->";

function fontSize(item) {
  return Math.hypot(item.transform[2], item.transform[3]) || item.height || 0;
}

// Text, horizontal extent and size of items on one baseline (items sorted by x).
function joinItems(y, items) {
  let text = "";
  let prevEnd = null;
  for (const it of items) {
    const x = it.transform[4];
    if (prevEnd !== null && x - prevEnd > fontSize(it) * 0.25 && !text.endsWith(" ")) text += " ";
    text += it.str;
    prevEnd = x + (it.width || 0);
  }
  const last = items[items.length - 1];
  return { y, items, text: text.trim(), size: Math.max(...items.map(fontSize)),
    left: items[0].transform[4], right: last.transform[4] + (last.width || 0) };
}

function toLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const y = it.transform[5];
    const size = fontSize(it);
    let row = rows.find((r) => Math.abs(r.y - y) < Math.max(2, size * 0.4));
    if (!row) rows.push((row = { y, items: [] }));
    row.items.push(it);
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => joinItems(r.y, r.items.sort((a, b) => a.transform[4] - b.transform[4])));
}

// Two-column pages: one baseline holds a left-column and a right-column line, so reading by y
// mixes the columns. If many lines have a wide gap across the page centre, every line is split
// there and the columns are read one after the other between full-width lines (titles, notes).
// Returns { lines } in reading order (column starts marked `columnStart`) for two columns,
// { lines: null } for a table-like page (many wide gaps per line: left as is, but the GPU reads
// tables better too), or null for an ordinary single-column page.
function columnOrder(lines, view) {
  const width = view[2] - view[0];
  const centre = view[0] + width / 2;
  const slack = width * 0.06;
  const gapsOf = (l) => {
    const gaps = [];
    for (let j = 1; j < (l.items?.length ?? 0); j++) {
      const a = l.items[j - 1], b = l.items[j];
      const end = a.transform[4] + (a.width || 0), start = b.transform[4];
      if (start - end > width * 0.015) gaps.push({ j, end, start });
    }
    return gaps;
  };
  const splitAt = (l) => gapsOf(l).find((g) => g.end < centre + slack && g.start > centre - slack)?.j ?? -1;
  const splitLines = lines.filter((l) => splitAt(l) > 0);
  if (splitLines.length < Math.max(5, lines.length * 0.25)) return null;
  if (splitLines.filter((l) => gapsOf(l).length > 1).length > splitLines.length * 0.3) return { lines: null };

  const out = [];
  let left = [], right = [];
  const flushColumns = () => {
    for (const col of [left, right]) col.forEach((l, k) => out.push(k ? l : { ...l, columnStart: true }));
    left = []; right = [];
  };
  for (const l of lines) {
    const j = splitAt(l);
    if (j > 0) {
      left.push(joinItems(l.y, l.items.slice(0, j)));
      right.push(joinItems(l.y, l.items.slice(j)));
    } else if (l.right <= centre + slack) left.push(l);
    else if (l.left >= centre - slack) right.push(l);
    else { flushColumns(); out.push(l); }
  }
  flushColumns();
  return { lines: out };
}

// A text layer that is mostly punctuation or private-use glyphs (fonts without a usable character
// map) is as useless as none: the page is treated like a scan so the GPU reads it instead.
function unreadable(lines) {
  const text = lines.map((l) => l.text).join("").replace(/\s+/g, "");
  if (text.length < 20) return false;
  const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  return letters < text.length * 0.5;
}

function bodySize(pages) {
  const weight = new Map();
  for (const lines of pages)
    for (const l of lines) {
      if (l.figure) continue;
      const k = Math.round(l.size);
      weight.set(k, (weight.get(k) || 0) + l.text.length);
    }
  let best = 10, max = 0;
  for (const [k, w] of weight) if (w > max) [best, max] = [k, w];
  return best;
}

// Running headers/footers repeat at the top or bottom of many pages (digits vary: "Page 12").
const PAGE_NUMBER = /^[\s\-–—|·•]*(page|p\.|pg\.?|第)?\s*\d{1,4}\s*(\/\s*\d{1,4}|of\s+\d{1,4}|页|쪽|페이지)?[\s\-–—|·•]*$/i;
const MARGIN = 0.09; // top/bottom share of the page treated as header/footer zone

function stripRunningLines(pages) {
  const key = (s) => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
  const atEdge = (l, h) => l.y > h * (1 - MARGIN) || l.y < h * MARGIN;
  const counts = new Map();
  for (const lines of pages) {
    const edges = new Set(lines.filter((l) => atEdge(l, lines.height)).map((l) => key(l.text)));
    for (const k of edges) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4));
  return pages.map((lines) => {
    const kept = lines.filter((l) => {
      if (!atEdge(l, lines.height)) return true;
      if (PAGE_NUMBER.test(l.text)) return false;
      return pages.length < 3 || (counts.get(key(l.text)) || 0) < threshold;
    });
    kept.height = lines.height;
    return kept;
  });
}

// Images drawn on a page, as boxes in PDF space. Text-only conversion cannot show them, so each
// becomes a `<!-- figure -->` line at its position (output.js turns it into "[Figure, p.N …]").
// Vector drawings (most charts) are not images and are not detected.
async function imageBoxes(page) {
  const { fnArray, argsArray } = await page.getOperatorList();
  const O = pdfjs.OPS;
  const paints = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintImageXObjectRepeat]);
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const boxes = [];
  fnArray.forEach((fn, i) => {
    const args = argsArray[i];
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() ?? ctm;
    else if (fn === O.transform) ctm = pdfjs.Util.transform(ctm, args);
    else if (fn === O.paintFormXObjectBegin) { stack.push(ctm); if (args?.[0]) ctm = pdfjs.Util.transform(ctm, args[0]); }
    else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (paints.has(fn)) {
      // An image fills the unit square under the current matrix.
      const [a, b, c, d, e, f] = ctm;
      const xs = [e, a + e, c + e, a + c + e], ys = [f, b + f, d + f, b + d + f];
      boxes.push({ left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) });
    }
  });
  return boxes;
}

// Keeps boxes that look like figures: not icons (< 2% of the page), not page backgrounds (> 85%),
// not text rendered as a picture (shadowed slide text: the same words sit in the text layer on
// top of it); touching boxes (one figure drawn in tiles) are merged.
function figureBoxes(boxes, view, lines) {
  const pageW = view[2] - view[0], pageH = view[3] - view[1];
  const area = (b) => ((b.right - b.left) * (b.top - b.bottom)) / (pageW * pageH);
  const coversText = (b) => lines.some((l) => l.y >= b.bottom && l.y <= b.top
    && Math.min(l.right, b.right) - Math.max(l.left, b.left) > 0.5 * Math.max(1, b.right - b.left));
  const thin = (b) => b.top - b.bottom < pageH * 0.02 || b.right - b.left < pageW * 0.02; // rules, borders
  const gap = pageH * 0.01;
  const merged = [];
  // Drop backgrounds, rules and text pictures first, or pictures next to them would merge through them.
  for (const b of boxes.filter((x) => area(x) <= 0.85 && !thin(x) && !coversText(x)).sort((p, q) => q.top - p.top)) {
    const hit = merged.find((m) => b.left <= m.right + gap && b.right >= m.left - gap && b.bottom <= m.top + gap && b.top >= m.bottom - gap);
    if (hit) Object.assign(hit, { left: Math.min(hit.left, b.left), right: Math.max(hit.right, b.right), bottom: Math.min(hit.bottom, b.bottom), top: Math.max(hit.top, b.top) });
    else merged.push({ ...b });
  }
  return merged.filter((b) => area(b) >= 0.02 && area(b) <= 0.85);
}

function heading(size, body) {
  if (size >= body * 1.6) return "# ";
  if (size >= body * 1.3) return "## ";
  if (size >= body * 1.15) return "### ";
  return "";
}

export async function pdfToMarkdown(file, onProgress, { keepHeaders = false } = {}) {
  const data = new Uint8Array(await file.arrayBuffer());
  const assets = globalThis.MDB_PDFJS_ASSETS ?? "/vendor/"; // the bench (Node) points this at pdfjs-dist
  const doc = await pdfjs.getDocument({
    data, isEvalSupported: false,
    cMapUrl: `${assets}cmaps/`, cMapPacked: true, standardFontDataUrl: `${assets}standard_fonts/`,
  }).promise;
  if (doc.numPages > MAX_PAGES) throw new Error("too_many_pages");
  let pages = [];
  const figures = [];
  const views = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const lines = toLines(content.items);
      if (unreadable(lines)) lines.length = 0;
      lines.height = page.view[3] - page.view[1];
      pages.push(lines);
      views.push(page.view);
      figures.push(lines.length ? figureBoxes(await imageBoxes(page), page.view, lines) : []); // no text = scan, not a figure
      onProgress?.(p / doc.numPages); // throws when the user presses Stop
    }
  } catch (e) {
    await doc.destroy();
    throw e;
  }
  if (!keepHeaders) pages = stripRunningLines(pages);
  // A picture at the same place on most pages is a template (logo, slide background), not a figure.
  const where = (b) => [b.left, b.right, b.bottom, b.top].map(Math.round).join(",");
  const seen = new Map();
  for (const boxes of figures) for (const k of new Set(boxes.map(where))) seen.set(k, (seen.get(k) || 0) + 1);
  const template = (b) => pages.length > 1 && seen.get(where(b)) >= Math.max(2, Math.ceil(pages.length * 0.5));
  pages.forEach((lines, i) => {
    for (const b of figures[i]) if (!template(b)) lines.push({ y: b.top, size: 0, text: "<!-- figure -->", figure: true, left: b.left, right: b.right });
    lines.sort((a, b) => b.y - a.y);
  });
  const body = bodySize(pages);
  const out = [];
  pages.forEach((lines, i) => {
    out.push(`<!-- page ${i + 1} -->`);
    if (!lines.length) {
      out.push(SCANNED_PAGE);
      return;
    }
    let para = [];
    let prev = null;
    const flush = () => { if (para.length) out.push(para.join(" ")); para = []; };
    // A gap only ends a paragraph when it is wider than this page's usual line spacing
    // (Chinese journals set lines ~2× the font size apart).
    const text = lines.filter((l) => !l.figure);
    const gaps = text.slice(1).map((l, j) => text[j].y - l.y).filter((g) => g > 0).sort((a, b) => a - b);
    const usual = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    const columns = columnOrder(lines, views[i]);
    for (const l of columns?.lines ?? lines) {
      if (l.columnStart) { flush(); prev = null; }
      if (l.figure) { flush(); out.push(l.text); prev = null; continue; }
      const h = heading(l.size, body);
      if (h) { flush(); out.push(h + l.text); prev = null; continue; }
      if (prev && prev.y - l.y > Math.max(Math.max(prev.size, l.size) * 1.8, usual * 1.4)) flush();
      if (/^([•▪●◦\-–*]|\d+[.)])\s/.test(l.text)) { flush(); out.push(l.text.replace(/^[•▪●◦–*]\s*/, "- ")); prev = l; continue; }
      para.push(l.text);
      prev = l;
    }
    flush();
    if (columns) out.push(NEEDS_GPU); // columns/tables are a guess here: the GPU's layout analysis is better
  });
  await doc.destroy();
  return out.join("\n\n").replace(/(\w)- (\w)/g, "$1$2") + "\n";
}
