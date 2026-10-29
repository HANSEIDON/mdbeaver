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
  }
  return lines;
}

function bodySize(pages) {
  const weight = new Map();
  for (const lines of pages)
    for (const l of lines) {
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
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = toLines(content.items);
    lines.height = page.view[3] - page.view[1];
    pages.push(lines);
    onProgress?.(p / doc.numPages);
  }
  if (!keepHeaders) pages = stripRunningLines(pages);
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
