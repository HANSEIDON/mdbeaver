import { estimateTokens, merge, optimize } from "./output.js";

const $ = (id) => document.getElementById(id);
const KINDS = { pdf: "PDF", docx: "DOCX", pptx: "PPTX" };
// doneFor: the inputs of the last complete run; Convert stays off until files or options change,
// so a stray click does not convert (and upload) everything again. abort: the running run's stop.
const state = { items: [], workerOnline: false, maxMb: 50, busy: false, results: [], doneFor: null, abort: null };

// --- worker status -----------------------------------------------------
async function refreshStatus() {
  try {
    const s = await (await fetch("/api/status", { cache: "no-store" })).json();
    state.workerOnline = !!s.worker_online;
    state.maxMb = s.max_upload_mb || state.maxMb;
  } catch {
    state.workerOnline = false;
  }
  $("status").dataset.state = state.workerOnline ? "online" : "offline";
  $("status-text").textContent = state.workerOnline ? "GPU beaver online" : "GPU beaver resting";
  renderRoute();
}

// Every file converts in the browser first. A PDF goes to the GPU only for pages the browser could
// not read (scans), or for every page with "Best quality". Matches worker MDB_MAX_GPU_PAGES.
const GPU_MAX_PAGES = 50;
const canUseGpu = (item) => item.kind === "pdf" && state.workerOnline && !$("local-only").checked && item.file.size <= state.maxMb * 1048576;

function renderRoute() {
  if (state.busy) return;
  if (!state.items.length) { $("route").textContent = "Free · add documents to start"; return; }
  const gpu = state.items.some(canUseGpu);
  const where = !gpu ? "runs in your browser" : $("best").checked ? "PDFs on our GPU server, the rest in your browser" : "in your browser · scanned pages on our GPU";
  $("route").textContent = `Free · ${state.items.length} file${state.items.length > 1 ? "s" : ""} · ${where}`;
}

// --- tabs and options ---------------------------------------------------
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
  $("tab-config").hidden = name !== "config";
  $("tab-results").hidden = name !== "results";
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
// What a run depends on; "Keep page numbers" only re-renders the output, so it is not part of it.
const inputsKey = () => JSON.stringify([state.items.map((it) => [it.file.name, it.file.size, it.file.lastModified]),
  $("best").checked, $("local-only").checked]);

function renderRun() {
  const done = !state.busy && state.items.length > 0 && state.doneFor === inputsKey();
  $("run").disabled = state.busy || !state.items.length || done;
  $("run").textContent = state.busy ? "Converting…" : done ? "Converted ✓" : "Convert";
  $("stop").hidden = !state.busy;
  if (!state.busy) $("stop").disabled = false;
}

for (const id of ["local-only", "best"]) $(id).addEventListener("change", () => { renderRoute(); renderRun(); });
$("keep-pages").addEventListener("change", () => { if (state.results.length) renderOutput(); });

// --- file list ---------------------------------------------------------
const formatSize = (b) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);
const kindOf = (name) => (name.match(/\.(pdf|docx|pptx)$/i)?.[1] || "").toLowerCase() || null;

function setMessage(text, isError = false) {
  $("message").hidden = !text;
  $("message").textContent = text || "";
  $("message").classList.toggle("error", isError);
}

function renderFiles() {
  const list = $("files");
  list.replaceChildren(...state.items.map((item, i) => {
    const li = document.createElement("li");
    const type = Object.assign(document.createElement("span"), { className: "ftype", textContent: KINDS[item.kind] });
    const meta = Object.assign(document.createElement("div"), { className: "fmeta" });
    meta.append(
      Object.assign(document.createElement("p"), { className: "fname", textContent: item.file.name }),
      Object.assign(document.createElement("p"), { className: `finfo ${item.status || ""}`, textContent: item.info || formatSize(item.file.size) }),
    );
    const remove = Object.assign(document.createElement("button"), { className: "icon-btn", textContent: "×", disabled: state.busy });
    remove.setAttribute("aria-label", `Remove ${item.file.name}`);
    remove.addEventListener("click", () => { state.items.splice(i, 1); renderFiles(); });
    li.append(type, meta, remove);
    return li;
  }));
  list.hidden = !state.items.length;
  $("drop").classList.toggle("compact", state.items.length > 0);
  renderRun();
  renderRoute();
}

function addFiles(files) {
  if (state.busy) return;
  let skipped = 0;
  for (const file of files) {
    const kind = kindOf(file.name);
    if (!kind) { skipped++; continue; }
    if (state.items.some((it) => it.file.name === file.name && it.file.size === file.size)) continue;
    state.items.push({ file, kind });
  }
  setMessage(skipped ? `Skipped ${skipped} file${skipped > 1 ? "s" : ""}: only PDF, DOCX and PPTX are supported.` : "", !!skipped);
  renderFiles();
}

const drop = $("drop");
drop.addEventListener("click", () => $("file").click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });
$("file").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });

// --- progress ----------------------------------------------------------
function progress(text, fraction = null) {
  $("route").textContent = text;
  $("bar").hidden = false;
  const fill = $("bar-fill");
  fill.classList.toggle("indeterminate", fraction === null);
  fill.style.width = fraction === null ? "" : `${Math.round(fraction * 100)}%`;
}

// --- conversion paths --------------------------------------------------
const CONVERTERS = {
  pdf: () => import("./pdf-local.js").then((m) => m.pdfToMarkdown),
  docx: () => import("./docx-local.js").then((m) => m.docxToMarkdown),
  pptx: () => import("./pptx-local.js").then((m) => m.pptxToMarkdown),
};

const stopped = () => new DOMException("stopped", "AbortError");

// The converters report progress per page; Stop takes effect at the next page.
async function convertLocal(item, label, signal) {
  const convert = await CONVERTERS[item.kind]();
  return convert(item.file, (f) => {
    if (signal?.aborted) throw stopped();
    progress(`${label} · chewing in your browser`, f);
  });
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(stopped()); }, { once: true });
});

async function convertServer(item, label, mode, pages, signal) {
  progress(`${label} · uploading`);
  const form = new FormData();
  form.append("file", item.file);
  form.append("mode", mode);
  if (pages) form.append("pages", pages.join(","));
  const r = await fetch("/api/jobs", { method: "POST", body: form, signal });
  if (!r.ok) {
    const err = new Error((await r.json().catch(() => ({}))).detail || `http_${r.status}`);
    err.fallback = [429, 502, 503, 504].includes(r.status);
    throw err;
  }
  const { id } = await r.json();
  // On Stop, withdraw the job so the GPU does not work on it (and the file is deleted at once).
  signal?.addEventListener("abort", () => fetch(`/api/jobs/${id}`, { method: "DELETE" }).catch(() => {}), { once: true });
  for (;;) {
    await sleep(1500, signal);
    const s = await (await fetch(`/api/jobs/${id}`, { cache: "no-store", signal })).json();
    if (s.status === "queued") progress(`${label} · in line #${s.position}`);
    else if (s.status === "running") progress(`${label} · the GPU beaver is chewing`);
    else if (s.status === "done") {
      fetch(`/api/jobs/${id}`, { method: "DELETE" }).catch(() => {});
      return s.markdown;
    } else {
      // Server-side failures (worker went offline, too many pages, engine error) fall back to the browser.
      const err = new Error(s.error || "failed");
      err.fallback = true;
      throw err;
    }
  }
}

// Split converter output on `<!-- page N -->` markers: Map(page number -> marker + body).
function splitPages(markdown) {
  const pages = new Map();
  for (const chunk of markdown.split(/(?=^<!-- page \d+ -->$)/m)) {
    const n = chunk.match(/^<!-- page (\d+) -->/)?.[1];
    if (n) pages.set(Number(n), chunk.trimEnd());
  }
  return pages;
}

function replacePages(local, gpu) {
  const pages = splitPages(local);
  for (const [n, chunk] of splitPages(gpu)) pages.set(n, chunk);
  return [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).join("\n\n") + "\n";
}

// Returns { markdown, gpu } where gpu is "unneeded", "done", or why scanned pages stayed empty:
// "offline" (no worker / browser-only), "too_many" (over GPU_MAX_PAGES) or "failed".
async function convert(item, label, onDraft, signal) {
  const local = await convertLocal(item, label, signal);
  if (item.kind !== "pdf") return { markdown: local, gpu: "unneeded" };
  const { SCANNED_PAGE, NEEDS_GPU } = await import("./pdf-local.js");
  const pages = splitPages(local);
  const all = [...pages.keys()];
  // Pages the browser could not read (scans) or could only guess the layout of (columns).
  const scanned = all.filter((n) => pages.get(n).endsWith(SCANNED_PAGE) || pages.get(n).endsWith(NEEDS_GPU));
  // Best quality redoes every page, unless that is over the GPU limit: then only the scans.
  const best = $("best").checked && all.length <= GPU_MAX_PAGES;
  const target = best ? all : scanned;
  const missed = (why) => ({ markdown: local, gpu: scanned.length ? why : "unneeded" });
  if (!target.length) return { markdown: local, gpu: "unneeded" };
  if (!canUseGpu(item)) return missed("offline");
  if (target.length > GPU_MAX_PAGES) return missed("too_many");
  onDraft(local);
  try {
    const gpu = await convertServer(item, label, best ? "precise" : "fast", best ? null : target, signal);
    return { markdown: replacePages(local, gpu), gpu: "done" };
  } catch (e) {
    if (!e.fallback) throw e;
    return missed("failed");
  }
}

// --- run + results -----------------------------------------------------
const mdName = (name) => name.replace(/\.(pdf|docx|pptx)$/i, ".md");

function outputs() {
  const keepPages = $("keep-pages").checked;
  return state.results.map((r) => ({ name: r.name, markdown: optimize(r.raw, { keepPages }) }));
}

function renderOutput() {
  const outs = outputs();
  const md = merge(outs);
  $("output").value = md;
  $("result-name").textContent = outs.length === 1 ? mdName(outs[0].name) : `merged-${outs.length}-documents.md`;
  $("result-stats").textContent = `${outs.length} file${outs.length > 1 ? "s" : ""} · ${md.length.toLocaleString()} chars · ~${estimateTokens(md).toLocaleString()} tokens`;
  $("download-zip").hidden = outs.length < 2;
}

async function run() {
  if (!state.items.length || state.busy) return;
  state.busy = true;
  state.results = [];
  const controller = new AbortController();
  state.abort = controller;
  setMessage("");
  let failed = 0;
  let halted = false;
  const missed = { offline: 0, too_many: 0, failed: 0 };
  for (const item of state.items) { item.status = ""; item.info = "waiting"; }
  renderFiles();

  const showResults = () => {
    renderOutput();
    $("empty").hidden = true;
    $("result").hidden = false;
    showTab("results");
  };

  for (const [i, item] of state.items.entries()) {
    if (controller.signal.aborted) { halted = true; item.info = "stopped"; continue; }
    const label = state.items.length > 1 ? `${i + 1}/${state.items.length} ${item.file.name}` : item.file.name;
    item.status = "busy"; item.info = "converting…"; renderFiles();
    const result = { name: item.file.name, raw: "" };
    // The browser draft is shown while the GPU redoes pages; its result then replaces the draft.
    const onDraft = (draft) => {
      result.raw = draft;
      if (!state.results.includes(result)) state.results.push(result);
      item.info = `draft ready · GPU ${$("best").checked ? "redoing every page" : "reading scanned or multi-column pages"}…`; renderFiles();
      showResults();
    };
    try {
      const { markdown, gpu } = await convert(item, label, onDraft, controller.signal);
      if (gpu in missed) missed[gpu]++;
      result.raw = markdown;
      if (!state.results.includes(result)) state.results.push(result);
      const tokens = estimateTokens(optimize(markdown));
      item.status = "done"; item.info = `done · ~${tokens.toLocaleString()} tokens`;
    } catch (e) {
      if (e.name === "AbortError") {
        halted = true;
        item.status = "";
        item.info = state.results.includes(result) ? "stopped · browser draft kept" : "stopped";
      } else {
        failed++;
        item.status = "error"; item.info = `failed (${e.message || e})`;
      }
    }
    renderFiles();
  }

  state.busy = false;
  state.abort = null;
  // Lock Convert only after a clean, complete run; after a stop, failure or skipped GPU pages
  // the same inputs can be converted again.
  const clean = !halted && !failed && !Object.values(missed).some(Boolean);
  state.doneFor = clean ? inputsKey() : null;
  $("bar").hidden = true;
  renderFiles();
  if (state.results.length) showResults();
  const notes = [];
  const n = (k) => `${k} PDF${k > 1 ? "s" : ""}`;
  if (halted) notes.push("Stopped. Files already converted are kept.");
  if (failed) notes.push(`${failed} file${failed > 1 ? "s" : ""} couldn't be converted.`);
  const why = "scanned pages are empty, multi-column pages may be out of order";
  if (missed.offline) notes.push(`${n(missed.offline)} had pages that need the GPU, which is resting${$("local-only").checked ? " (or Browser only is on)" : ""}: ${why}. Try again later.`);
  if (missed.too_many) notes.push(`${n(missed.too_many)} had more than ${GPU_MAX_PAGES} pages that need the GPU (over its limit): ${why}.`);
  if (missed.failed) notes.push(`The GPU server couldn't finish ${n(missed.failed)}: ${why}.`);
  setMessage(notes.join(" "), failed > 0);
}
$("run").addEventListener("click", run);
$("stop").addEventListener("click", () => {
  state.abort?.abort();
  $("stop").disabled = true; // until the run winds down (at most one page)
  progress("Stopping…");
});

// --- export ------------------------------------------------------------
function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("output").value); }
  catch { $("output").select(); document.execCommand("copy"); }
  $("copy").textContent = "Copied";
  setTimeout(() => { $("copy").textContent = "Copy"; }, 1500);
});

$("download").addEventListener("click", () => {
  save(new Blob([$("output").value], { type: "text/markdown;charset=utf-8" }), $("result-name").textContent);
});

$("download-zip").addEventListener("click", async () => {
  const zip = new window.JSZip();
  const used = new Set();
  for (const o of outputs()) {
    let name = mdName(o.name), n = 2;
    while (used.has(name)) name = mdName(o.name).replace(/\.md$/, `-${n++}.md`);
    used.add(name);
    zip.file(name, o.markdown);
  }
  save(await zip.generateAsync({ type: "blob" }), "mdbeaver-documents.zip");
});

// --- donate ------------------------------------------------------------
$("donate-open").addEventListener("click", () => $("donate").showModal());
$("donate").addEventListener("click", (e) => { if (e.target === $("donate")) $("donate").close(); }); // click outside

refreshStatus();
setInterval(refreshStatus, 15000);
