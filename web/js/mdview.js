// Read-only Markdown view for the Results tab: line numbers and light syntax colouring.
// Only what mdbeaver itself emits is coloured: headings, tables, lists, quotes, code and math
// blocks, page and figure markers, <document> wrappers, **bold**, `code` and $math$.

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (cls, s) => `<span class="${cls}">${esc(s)}</span>`;

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[p\.\d+\])|(\[Figure[^\]]*\])|(\$[^$]+\$)/g;
const INLINE_CLS = ["c-ic", "c-strong", "c-page", "c-fig", "c-math"];

function inline(text) {
  let out = "", last = 0;
  for (const m of text.matchAll(INLINE)) {
    out += esc(text.slice(last, m.index));
    out += span(INLINE_CLS[m.slice(1).findIndex(Boolean)], m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

function line(text, block) {
  if (block) return span(block, text);
  let m;
  if ((m = text.match(/^(#{1,6})(\s.*)$/))) return span("c-p", m[1]) + `<span class="c-h">${inline(m[2])}</span>`;
  if (/^\s*<!--.*-->\s*$/.test(text)) return span("c-comment", text);
  if (/^\s*<\/?document\b.*>\s*$/.test(text)) return span("c-tag", text);
  if (/^\s*\|[\s:|-]+\|?\s*$/.test(text) || /^\s*(-{3,}|\*{3,})\s*$/.test(text)) return span("c-p", text);
  if (/^\s*\|/.test(text)) return text.split("|").map(inline).join(span("c-p", "|"));
  if ((m = text.match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/))) return esc(m[1]) + span("c-p", m[2]) + esc(m[3]) + inline(m[4]);
  if ((m = text.match(/^(\s*>+)(.*)$/))) return span("c-p", m[1]) + `<span class="c-quote">${inline(m[2])}</span>`;
  return inline(text);
}

export function renderMarkdown(el, md) {
  const lines = md.replace(/\n$/, "").split("\n");
  let block = null; // "fence" inside ``` … ```, "math" inside $$ … $$
  const html = lines.map((text) => {
    const t = text.trim();
    let cls = block;
    if (t.startsWith("```")) { cls = "c-fence"; block = block === "c-fence" ? null : block || "c-fence"; }
    else if (t === "$$" && block !== "c-fence") { cls = "c-math"; block = block === "c-math" ? null : "c-math"; }
    return `<span class="l">${line(text, cls) || " "}</span>`;
  });
  el.style.setProperty("--digits", String(lines.length).length);
  el.innerHTML = html.join("");
  return lines.length;
}
