// Benchmark C, step 1 — writes what the AI would be given for every document in bench/docs,
// one file per variant, to bench/out/variants/<doc>/<variant>.md (all after web/js/output.js):
//   plain            text layer copy-paste, no structure
//   browser          in-browser converter only (the "Browser only" option)
//   hybrid           the site's default: browser, with pages lacking a text layer from the GPU
//   best             every page from the GPU, standard tier
//   precise          every page from the GPU, advanced tier: the site's "Best quality"
//                    (needs bench/out/worker-mineru-precise-<doc>.md)
//   <variant>+pages  the same with [p.N] markers ("Keep page numbers")
// GPU pages come from bench/out/worker-mineru-<doc>.md (worker/engines/mineru.py output).
//
//   node --import ./node-shim.mjs variants.mjs
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { optimize } from "../web/js/output.js";
import { plainText } from "./tokens.mjs";

const ROOT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DOCS = join(ROOT, "docs");
const OUT = join(ROOT, "out", "variants");

// Same page split/merge as web/js/app.js.
function splitPages(markdown) {
  const pages = new Map();
  for (const chunk of markdown.split(/(?=^<!-- page \d+ -->$)/m)) {
    const n = chunk.match(/^<!-- page (\d+) -->/)?.[1];
    if (n) pages.set(Number(n), chunk.trimEnd());
  }
  return pages;
}

function hybrid(local, gpu, markers) {
  const pages = splitPages(local);
  const gpuPages = splitPages(gpu);
  for (const [n, chunk] of pages) if (markers.some((m) => chunk.endsWith(m)) && gpuPages.has(n)) pages.set(n, gpuPages.get(n));
  return [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).join("\n\n") + "\n";
}

const { pdfToMarkdown, SCANNED_PAGE, NEEDS_GPU } = await import("../web/js/pdf-local.js");
for (const name of (await readdir(DOCS)).filter((f) => f.endsWith(".pdf")).sort()) {
  const doc = name.replace(/\.pdf$/, "");
  const gpuPath = join(ROOT, "out", `worker-mineru-${doc}.md`);
  if (!existsSync(gpuPath)) { console.log(`skip ${doc}: no GPU output at ${gpuPath}`); continue; }
  const bytes = await readFile(join(DOCS, name));
  const local = await pdfToMarkdown(new globalThis.BenchFile(bytes, name));
  const gpu = await readFile(gpuPath, "utf8");
  const raw = { browser: local, hybrid: hybrid(local, gpu, [SCANNED_PAGE, NEEDS_GPU]), best: gpu };
  // The site's "Best quality" runs MinerU's advanced tier (mode "precise"): charts become tables,
  // diagrams Mermaid or a description. `best` above is the standard tier (mode "fast").
  const precisePath = join(ROOT, "out", `worker-mineru-precise-${doc}.md`);
  if (existsSync(precisePath)) raw.precise = await readFile(precisePath, "utf8");
  const out = { plain: await plainText("pdf", bytes) };
  for (const [k, v] of Object.entries(raw)) {
    out[k] = optimize(v);
    out[`${k}+pages`] = optimize(v, { keepPages: true });
  }
  await mkdir(join(OUT, doc), { recursive: true });
  for (const [k, v] of Object.entries(out)) await writeFile(join(OUT, doc, `${k}.md`), v);
  console.log(`✓ ${doc}: ${Object.keys(out).join(", ")}`);
}
