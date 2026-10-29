// Token-minimal Markdown. Every conversion path (browser or GPU worker) runs
// through optimize(), so the output style is decided in exactly one place.
// Converters emit `<!-- page N -->` markers; they become `[p.N]` or disappear.
// They mark figures with `<!-- figure -->` or `<!-- figure: caption -->`; the image itself is not
// in the text, so the line always names its page and lets the AI ask the user for that image.

const INVISIBLE = /[­​-‍⁠﻿]/g;
const ODD_SPACES = /[  -   　]/g;
const LIGATURES = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };
const BULLET = /^(\s*)(?:[-*+]\s+)?[•▪●◦‣∙·▸►■□–]\s+/; // also "- • x" (list marker + bullet glyph in text)
const DECORATION = /^\s*[-_=*·•.…~―—–─━═]{3,}\s*$/;
const SCANNED = /^_\(no text layer — scanned page, needs OCR\)_$/;

function htmlTableToMarkdown(html) {
  const table = new DOMParser().parseFromString(html, "text/html").querySelector("table");
  if (!table) return html;
  const grid = [];
  [...table.rows].forEach((tr, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of tr.cells) {
      while (grid[r][c] !== undefined) c++;
      const text = cell.textContent.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
      const cs = Math.max(1, cell.colSpan || 1), rs = Math.max(1, cell.rowSpan || 1);
      for (let dr = 0; dr < rs; dr++)
        for (let dc = 0; dc < cs; dc++) (grid[r + dr] ??= [])[c + dc] = text;
      c += cs;
    }
  });
  const width = Math.max(0, ...grid.map((r) => r.length));
  if (!width) return "";
  const row = (r) => `|${Array.from({ length: width }, (_, i) => r[i] ?? "").join("|")}|`;
  return [row(grid[0]), `|${Array(width).fill("-").join("|")}|`, ...grid.slice(1).map(row)].join("\n");
}

export function optimize(markdown, { keepPages = false } = {}) {
  let md = markdown
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "")
    .replace(ODD_SPACES, " ")
    .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] ?? c)
    // Full-width Latin letters and digits (common in Chinese typesetting) cost far more tokens than
    // ASCII; CJK punctuation (，。：) is left alone.
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    // Chinese/Japanese have no spaces between characters; justified layouts make text extraction
    // insert them ("美 学 理 论"). Hangul is excluded: Korean separates words with spaces.
    .replace(/(?<=[　-〿぀-ヿ一-鿿＀-￯])[ \t]+(?=[　-〿぀-ヿ一-鿿＀-￯])/g, "")
    .replace(/<table[\s\S]*?<\/table>/gi, htmlTableToMarkdown);

  const out = [];
  let prev = null;
  let pageNo = null;
  for (let line of md.split("\n")) {
    const page = line.match(/^<!-- page (\d+) -->$/);
    if (page) { pageNo = page[1]; if (keepPages) out.push(`[p.${pageNo}]`); continue; }
    if (line.trim() === "<!-- needs-gpu -->") continue; // routing hint for app.js, not content
    const figure = line.trim().match(/^<!-- figure(?::\s*(.*?))? -->$/);
    if (figure) {
      const where = pageNo ? `, p.${pageNo}` : "";
      line = `[Figure${where}${figure[1] ? `: ${figure[1]}` : ""} — image not included]`;
    }
    if (SCANNED.test(line.trim())) line = "[scanned page: no text layer]";
    if (DECORATION.test(line) || /^#{1,6}\s*$/.test(line)) continue;
    line = line.replace(BULLET, "$1- ");
    const indent = line.match(/^\s*/)[0];
    line = indent + line.slice(indent.length).replace(/[ \t]+/g, " ").trimEnd();
    if (line && line === prev && !line.startsWith("|")) continue; // drop exact repeats (e.g. duplicated watermarks), never table rows
    out.push(line);
    if (line) prev = line;
  }

  return out.join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(\s*- .*)\n\n(?=\s*- )/gm, "$1\n")
    .trim() + "\n";
}

// Several files → one Markdown file. <document> tags keep sources apart cheaply
// and are a widely recommended way to hand multiple documents to an LLM.
export function merge(results) {
  if (results.length === 1) return results[0].markdown;
  return results.map((r) => `<document name="${r.name.replace(/"/g, "'")}">\n${r.markdown.trim()}\n</document>`).join("\n\n") + "\n";
}

export function estimateTokens(text) {
  const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
  return Math.round(cjk * 1.2 + (text.length - cjk) / 4);
}
