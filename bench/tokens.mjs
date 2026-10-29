// Benchmark A — token counts. Runs the exact converters the website uses (web/js)
// on every document in bench/docs and compares token cost across output variants.
//
//   npm run tokens               # docs from bench/docs
//   npm run tokens -- path/to/dir
//
// External tools can be compared by dropping their output in
// bench/baselines/<tool>/<document file name>.md (e.g. baselines/markitdown/report.pdf.md).
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getEncoding } from "js-tiktoken";
import JSZip from "jszip";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { optimize } from "../web/js/output.js";

const ROOT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DOCS = process.argv[2] || join(ROOT, "docs");
const BASELINES = join(ROOT, "baselines");
const ENCODERS = { o200k: getEncoding("o200k_base"), cl100k: getEncoding("cl100k_base") };

const CONVERTERS = {
  pdf: async () => (await import("../web/js/pdf-local.js")).pdfToMarkdown,
  docx: async () => (await import("../web/js/docx-local.js")).docxToMarkdown,
  pptx: async () => (await import("../web/js/pptx-local.js")).pptxToMarkdown,
};

const count = (text) => Object.fromEntries(Object.entries(ENCODERS).map(([k, enc]) => [k, enc.encode(text, [], []).length]));

function language(text) {
  const n = (re) => (text.match(re) || []).length;
  const counts = { ko: n(/[가-힯]/g), zh: n(/[一-鿿]/g), ja: n(/[぀-ヿ]/g), en: n(/[A-Za-z]/g) / 4 };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// Baseline: what you get by copy-pasting the text with no structure (like pdftotext).
async function plainText(kind, bytes) {
  if (kind === "pdf") {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const { items } = await (await doc.getPage(p)).getTextContent();
      pages.push(items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join(""));
    }
    await doc.destroy();
    return pages.join("\n\n");
  }
  const zip = await JSZip.loadAsync(bytes);
  const tag = kind === "docx" ? /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g : /<a:t>([^<]*)<\/a:t>/g;
  const parts = Object.keys(zip.files).filter((p) => (kind === "docx" ? p === "word/document.xml" : /^ppt\/slides\/slide\d+\.xml$/.test(p)));
  parts.sort((a, b) => (parseInt(a.match(/\d+/)?.[0] ?? 0) - parseInt(b.match(/\d+/)?.[0] ?? 0)));
  const texts = [];
  for (const p of parts) texts.push([...(await zip.file(p).async("string")).matchAll(tag)].map((m) => m[1]).join(" "));
  return texts.join("\n\n");
}

// Each external output is counted as-is and after the site's optimizer (`<tool>+opt`), since GPU
// engine output reaches users through web/js/output.js just like the browser converters' output.
async function externalBaselines(fileName) {
  if (!existsSync(BASELINES)) return {};
  const out = {};
  for (const tool of await readdir(BASELINES)) {
    const path = join(BASELINES, tool, `${fileName}.md`);
    if (!existsSync(path)) continue;
    out[tool] = await readFile(path, "utf8");
    out[`${tool}+opt`] = optimize(out[tool]);
  }
  return out;
}

const pct = (a, b) => (b ? `${Math.round((1 - a / b) * 100)}%` : "-");

async function main() {
  if (!existsSync(DOCS)) {
    console.error(`No documents folder: ${DOCS}\nPut PDF/DOCX/PPTX files there (it is gitignored).`);
    process.exit(1);
  }
  const files = (await readdir(DOCS)).filter((f) => /\.(pdf|docx|pptx)$/i.test(f)).sort();
  const results = [];
  for (const name of files) {
    const kind = name.split(".").pop().toLowerCase();
    const bytes = await readFile(join(DOCS, name));
    const started = Date.now();
    try {
      const raw = await (await CONVERTERS[kind]())(new globalThis.BenchFile(bytes, name));
      const variants = {
        plain: await plainText(kind, bytes),
        raw,
        mdbeaver: optimize(raw),
        "mdbeaver+pages": optimize(raw, { keepPages: true }),
        ...(await externalBaselines(name)),
      };
      const tokens = Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, count(v)]));
      results.push({ name, kind, bytes: bytes.length, lang: language(variants.mdbeaver), ms: Date.now() - started, tokens });
      console.log(`✓ ${name}`);
    } catch (e) {
      results.push({ name, kind, error: String(e.message || e) });
      console.log(`✗ ${name}: ${e.message || e}`);
    }
  }

  const ok = results.filter((r) => !r.error);
  console.log("\nTokens (o200k_base) — saving = mdbeaver vs plain copy-paste / vs unoptimized");
  console.table(ok.map((r) => ({
    document: r.name.length > 34 ? r.name.slice(0, 31) + "…" : r.name,
    lang: r.lang,
    plain: r.tokens.plain.o200k,
    raw: r.tokens.raw.o200k,
    mdbeaver: r.tokens.mdbeaver.o200k,
    "+pages": r.tokens["mdbeaver+pages"].o200k,
    "vs plain": pct(r.tokens.mdbeaver.o200k, r.tokens.plain.o200k),
    "vs raw": pct(r.tokens.mdbeaver.o200k, r.tokens.raw.o200k),
  })));

  const sum = (key, enc) => ok.reduce((s, r) => s + (r.tokens[key]?.[enc] ?? 0), 0);
  for (const enc of Object.keys(ENCODERS)) {
    console.log(`${enc}: plain ${sum("plain", enc)} → mdbeaver ${sum("mdbeaver", enc)} (${pct(sum("mdbeaver", enc), sum("plain", enc))} vs plain, ${pct(sum("mdbeaver", enc), sum("raw", enc))} vs raw)`);
  }

  const builtIn = ["plain", "raw", "mdbeaver", "mdbeaver+pages"];
  const tools = [...new Set(ok.flatMap((r) => Object.keys(r.tokens)))].filter((k) => !builtIn.includes(k)).sort();
  if (tools.length) {
    // Totals only over documents every external tool covered, so the columns are comparable.
    const covered = ok.filter((r) => tools.every((t) => r.tokens[t]));
    const total = (key) => covered.reduce((s, r) => s + r.tokens[key].o200k, 0);
    console.log(`\nExternal outputs (o200k, ${covered.length} documents covered by every tool)`);
    console.table(["plain", "mdbeaver", ...tools].map((k) => ({ variant: k, tokens: total(k), "vs plain": pct(total(k), total("plain")) })));
  }

  await mkdir(join(ROOT, "results"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = join(ROOT, "results", `${stamp}-tokens.json`);
  await writeFile(out, JSON.stringify({ created: new Date().toISOString(), encoders: Object.keys(ENCODERS), results }, null, 2));
  console.log(`\nSaved ${out}`);
}

main();
