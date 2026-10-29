// Browser-side PDF → Markdown fallback. Reads the text layer only:
// headings are guessed from font size, paragraphs from vertical gaps.
import * as pdfjs from "/vendor/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";

const MAX_PAGES = 500;
// Body of a page with no text layer; app.js looks for it to send those pages to the GPU.
export const SCANNED_PAGE = "_(no text layer — scanned page, needs OCR)_";

function fontSize(item) {
  return Math.hypot(item.transform[2], item.transform[3]) || item.height || 0;
}

function toLines(items) {
  const lines = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const y = it.transform[5];
    const size = fontSize(it);
    let line = lines.find((l) => Math.abs(l.y - y) < Math.max(2, size * 0.4));
    if (!line) lines.push((line = { y, size: 0, items: [] }));
    line.items.push(it);
    line.size = Math.max(line.size, size);
  }
  lines.sort((a, b) => b.y - a.y);
  for (const l of lines) {
    l.items.sort((a, b) => a.transform[4] - b.transform[4]);
    let text = "";
    let prevEnd = null;
    for (const it of l.items) {
      const x = it.transform[4];
      if (prevEnd !== null && x - prevEnd > fontSize(it) * 0.25 && !text.endsWith(" ")) text += " ";
      text += it.str;
      prevEnd = x + (it.width || 0);
    }
    l.text = text.trim();
    const last = l.items[l.items.length - 1];
    l.left = l.items[0].transform[4];
    l.right = last.transform[4] + (last.width || 0);
  }
  return lines;
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
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  if (doc.numPages > MAX_PAGES) throw new Error("too_many_pages");
  let pages = [];
  const figures = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = toLines(content.items);
    lines.height = page.view[3] - page.view[1];
    pages.push(lines);
    figures.push(lines.length ? figureBoxes(await imageBoxes(page), page.view, lines) : []); // no text = scan, not a figure
    onProgress?.(p / doc.numPages);
  }
  if (!keepHeaders) pages = stripRunningLines(pages);
  // A picture at the same place on most pages is a template (logo, slide background), not a figure.
  const where = (b) => [b.left, b.right, b.bottom, b.top].map(Math.round).join(",");
  const seen = new Map();
  for (const boxes of figures) for (const k of new Set(boxes.map(where))) seen.set(k, (seen.get(k) || 0) + 1);
  const template = (b) => pages.length > 1 && seen.get(where(b)) >= Math.max(2, Math.ceil(pages.length * 0.5));
  pages.forEach((lines, i) => {
    for (const b of figures[i]) if (!template(b)) lines.push({ y: b.top, size: 0, text: "<!-- figure -->", figure: true });
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
    for (const l of lines) {
      if (l.figure) { flush(); out.push(l.text); prev = null; continue; }
      const h = heading(l.size, body);
      if (h) { flush(); out.push(h + l.text); prev = null; continue; }
      if (prev && prev.y - l.y > Math.max(prev.size, l.size) * 1.8) flush();
      if (/^([•▪●◦\-–*]|\d+[.)])\s/.test(l.text)) { flush(); out.push(l.text.replace(/^[•▪●◦–*]\s*/, "- ")); prev = l; continue; }
      para.push(l.text);
      prev = l;
    }
    flush();
  });
  await doc.destroy();
  return out.join("\n\n").replace(/(\w)- (\w)/g, "$1$2") + "\n";
}
