import { renderMarkdown } from "./mdview.js";
import { estimateTokens, merge, optimize, pageCount } from "./output.js";

const $ = (id) => document.getElementById(id);
// "standard": browser first, GPU only for pages it can't read; "best": every PDF page on the GPU;
// "device": nothing is uploaded.
const mode = () => document.querySelector('input[name="mode"]:checked').value;
const MODE_HELP = {
  standard: () => "Converts in your browser. Only scanned or multi-column pages go to the GPU.",
  best: () => `Every PDF page goes through the GPU: better tables, formulas and reading order. Slower; up to ${state.maxPages} pages.`,
  device: () => "Nothing leaves your device. Scanned pages come out empty.",
};
// doneFor: the inputs of the last complete run; Convert stays off until files or options change,
// so a stray click does not convert (and upload) everything again. abort: the running run's stop.
// maxMb / maxPages: upload size and GPU pages per file (the gateway's, or the coupon's).
const state = { items: [], workerOnline: false, maxMb: 50, maxPages: 50, coupon: null, busy: false, results: [], warnings: [], md: "", doneFor: null, abort: null };

// --- worker status -----------------------------------------------------
async function refreshStatus() {
  try {
    const s = await (await fetch("/api/status", { cache: "no-store" })).json();
    state.workerOnline = !!s.worker_online;
    if (!state.coupon) {
      state.maxMb = s.max_upload_mb || state.maxMb;
      state.maxPages = s.max_gpu_pages || state.maxPages;
    }
  } catch {
    state.workerOnline = false;
  }
  $("status").dataset.state = state.workerOnline ? "online" : "offline";
  $("status-text").textContent = state.workerOnline ? "GPU ONLINE" : "GPU RESTING";
  renderRoute();
  renderMode();
}

// Every file converts in the browser first. A PDF goes to the GPU only for pages the browser could
// not read (scans), or for every page with "Best quality", up to state.maxPages per file.
const canUseGpu = (item) => item.kind === "pdf" && state.workerOnline && mode() !== "device" && item.file.size <= state.maxMb * 1048576;

function renderRoute() {
  if (state.busy) return;
  if (!state.items.length) { $("route").textContent = "Free · add files to start"; return; }
  const gpu = state.items.some(canUseGpu);
  const where = !gpu ? "in your browser" : mode() === "best" ? "PDFs on the GPU" : "browser first, GPU when needed";
  $("route").textContent = `${state.items.length} file${state.items.length > 1 ? "s" : ""} · ${where}`;
}

// --- tabs and options ---------------------------------------------------
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
  $("tab-config").hidden = name !== "config";
  $("tab-results").hidden = name !== "results";
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
// What a run depends on; "Keep page numbers" only re-renders the output, so it is not part of it.
const inputsKey = () => JSON.stringify([state.items.map((it) => [it.file.name, it.file.size, it.file.lastModified]), mode()]);

function renderRun() {
  const done = !state.busy && state.items.length > 0 && state.doneFor === inputsKey();
  $("run").disabled = state.busy || !state.items.length || done;
  $("run").textContent = state.busy ? "Converting…" : done ? "Converted ✓" : "Convert";
  $("stop").hidden = !state.busy;
  if (!state.busy) $("stop").disabled = false;
}

function renderMode() {
  $("mode-help").textContent = MODE_HELP[mode()]();
  $("best-limit").textContent = `≤${state.maxPages} pages`;
}
for (const r of document.querySelectorAll('input[name="mode"]')) r.addEventListener("change", () => { renderMode(); renderRoute(); renderRun(); });
renderMode();
// --- coupons: codes the owner hands out; they raise the GPU page and upload limits per file.
// Some never run out, some can be used a set number of times or until a date.
const saved = {
  get: () => { try { return localStorage.getItem("mdb-coupon") || ""; } catch { return ""; } },
  set: (v) => { try { v ? localStorage.setItem("mdb-coupon", v) : localStorage.removeItem("mdb-coupon"); } catch {} },
};

function renderCoupon(message = "") {
  const c = state.coupon;
  $("coupon-form").hidden = !!c;
  $("coupon-on").hidden = !c;
  if (c) {
    const uses = c.uses_left === null ? "" : ` · ${count(c.uses_left, "use")} left`;
    $("coupon-text").textContent = `Coupon on · GPU up to ${c.max_gpu_pages} pages, ${c.max_upload_mb} MB per file${uses}${c.expires ? ` · until ${c.expires}` : ""}`;
  }
  $("coupon-msg").hidden = !message;
  $("coupon-msg").textContent = message;
  renderMode();
  renderRoute();
}

const COUPON_ERRORS = {
  403: "That coupon doesn't exist.",
  429: "Too many tries. Wait a while and try again.",
  expired: "That coupon has expired.",
  used_up: "That coupon has been used up.",
};

function dropCoupon(message = "") {
  state.coupon = null;
  saved.set("");
  renderCoupon(message);
  refreshStatus(); // back to the normal limits
}

// quiet: checking a saved coupon on load, so a dead one just disappears.
async function applyCoupon(code, quiet = false) {
  let r;
  try { r = await fetch("/api/coupon", { method: "POST", headers: { "X-Coupon": code } }); }
  catch { if (!quiet) renderCoupon("Couldn't reach the server. Try again."); return; }
  if (r.ok) {
    state.coupon = { code, ...(await r.json()) };
    state.maxPages = state.coupon.max_gpu_pages;
    state.maxMb = state.coupon.max_upload_mb;
    saved.set(code);
    renderCoupon();
    // Pages skipped earlier for being over the limit can go now, but only on a new run: say so.
    if (!state.busy && state.warnings.some((w) => w.gpu === "too_many" || w.gpu === "too_big"))
      setMessage("Coupon applied. Press Convert again to send the skipped pages to the GPU.");
    return;
  }
  const detail = r.status === 410 ? (await r.json().catch(() => ({}))).detail : r.status;
  const wasOn = !!state.coupon;
  if (wasOn || quiet) dropCoupon(wasOn ? `${COUPON_ERRORS[detail] || "That coupon stopped working."} Back to the normal limits.` : "");
  else renderCoupon(COUPON_ERRORS[detail] || "That coupon doesn't work.");
}

$("coupon-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("coupon-code").value.trim();
  if (code) applyCoupon(code);
});
$("coupon-off").addEventListener("click", () => { $("coupon-code").value = ""; dropCoupon(); });
if (saved.get()) applyCoupon(saved.get(), true); // a coupon saved earlier: check it still works

// Output options only re-render the text; nothing is converted again.
for (const el of document.querySelectorAll(".output-opt")) el.addEventListener("change", () => { if (state.results.length) renderOutput(); });

// --- file list ---------------------------------------------------------
const formatSize = (b) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);
const kindOf = (name) => (name.match(/\.(pdf|docx|pptx)$/i)?.[1] || "").toLowerCase() || null;

function setMessage(text, isError = false) {
  $("message").hidden = !text;
  $("message").textContent = text || "";
  $("message").classList.toggle("error", isError);
}

function renderFiles() {
  const cell = (className, text) => Object.assign(document.createElement("td"), { className, textContent: text });
  $("files").replaceChildren(...state.items.map((item, i) => {
    const tr = document.createElement("tr");
    const remove = Object.assign(document.createElement("button"), { className: "icon-btn", textContent: "×", disabled: state.busy });
    remove.setAttribute("aria-label", `Remove ${item.file.name}`);
    remove.addEventListener("click", () => { state.items.splice(i, 1); renderFiles(); });
    const removeCell = cell("num", "");
    removeCell.append(remove);
    const nameCell = cell("name", "");
    if (state.results.some((r) => r.name === item.file.name)) {
      // Converted: the name jumps to where this file starts in the output.
      const jump = Object.assign(document.createElement("button"), { className: "jump", textContent: item.file.name, title: "Show in the output" });
      jump.addEventListener("click", () => jumpTo(item.file.name));
      nameCell.append(jump);
    } else nameCell.textContent = item.file.name;
    const statusCell = cell(`num st ${item.status || ""}`, (item.status === "warn" ? "⚠ " : "") + (item.info || "ready"));
    item.bar = item.statusCell = null;
    if (item.status === "busy") {
      // A thin line right of the name; progress() fills it and updates the status without a re-render.
      const pbar = Object.assign(document.createElement("span"), { className: "pbar" });
      item.bar = pbar.appendChild(document.createElement("i"));
      setBar(item.bar, item.progress ?? 0);
      const line = Object.assign(document.createElement("div"), { className: "name-line" });
      line.append(Object.assign(document.createElement("span"), { className: "fname", textContent: item.file.name }), pbar);
      nameCell.replaceChildren(line);
      item.statusCell = statusCell;
    }
    tr.append(nameCell, cell("num", formatSize(item.file.size)), statusCell, removeCell);
    return tr;
  }));
  $("files").parentElement.classList.toggle("has-rows", state.items.length > 0);
  $("no-files").hidden = state.items.length > 0;
  $("drop").classList.toggle("compact", state.items.length > 0);
  document.querySelector(".source").classList.toggle("is-empty", !state.items.length);
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

// --- progress: the bottom line follows the whole run, each file row has its own line ---
// f is 0..1 for one file. A PDF's browser pass fills the first 40% (the GPU may still follow);
// the GPU reports no page progress, so its part fills by an estimate from the page count.
const BROWSER_SHARE = 0.4;
const setBar = (el, f) => { el.style.width = `${Math.round(f * 100)}%`; };

function progress(text, item, f, short) {
  $("working").hidden = false;
  $("working-text").textContent = text;
  if (!item) return;
  item.progress = f = Math.max(f, item.progress ?? 0); // never runs backwards
  const i = state.items.indexOf(item), n = state.items.length;
  $("working-count").textContent = n > 1 ? `${i + 1} of ${n}` : "";
  setBar($("working-bar"), (i + f) / n);
  if (item.bar) setBar(item.bar, f);
  if (item.statusCell) item.statusCell.textContent = short ?? `${Math.round(f * 100)}%`;
}

// Text pages take about a second on the home GPU (figure-heavy ones several), plus start-up. The
// line approaches the end without reaching it, so a slow job never looks finished.
function gpuEstimate(started, pages, mode) {
  const expected = 2 + pages * (mode === "precise" ? 1.6 : 1);
  return BROWSER_SHARE + (0.97 - BROWSER_SHARE) * (1 - Math.exp(-(Date.now() - started) / 1000 / expected));
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
    progress(`Reading ${label} in your browser`, item, item.kind === "pdf" ? f * BROWSER_SHARE : f);
  });
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(stopped()); }, { once: true });
});

async function convertServer(item, label, mode, pages, pageCount, signal) {
  progress(`Sending ${label} to the GPU`, item, BROWSER_SHARE, "sending");
  const form = new FormData();
  form.append("file", item.file);
  form.append("mode", mode);
  if (pages) form.append("pages", pages.join(","));
  const coupon = state.coupon?.code;
  const headers = coupon ? { "X-Coupon": coupon } : {};
  const r = await fetch("/api/jobs", { method: "POST", body: form, headers, signal });
  if (!r.ok) {
    const err = new Error((await r.json().catch(() => ({}))).detail || `http_${r.status}`);
    err.fallback = [429, 502, 503, 504].includes(r.status);
    throw err;
  }
  const { id } = await r.json();
  // On Stop, withdraw the job so the GPU does not work on it (and the file is deleted at once).
  signal?.addEventListener("abort", () => fetch(`/api/jobs/${id}`, { method: "DELETE" }).catch(() => {}), { once: true });
  let started = null;
  for (;;) {
    await sleep(1000, signal);
    const s = await (await fetch(`/api/jobs/${id}`, { cache: "no-store", signal })).json();
    if (s.status === "queued") progress(`${label} · in line for the GPU, #${s.position}`, item, BROWSER_SHARE, `in line #${s.position}`);
    else if (s.status === "running") {
      started ??= Date.now();
      // Long jobs run in chunks and report how far they are; until then, estimate.
      const real = s.progress == null ? 0 : BROWSER_SHARE + (0.97 - BROWSER_SHARE) * s.progress;
      const done = s.progress == null ? "" : ` · ${Math.round(s.progress * 100)}%`;
      progress(`Reading ${label} on the GPU${done}`, item, Math.max(real, gpuEstimate(started, pageCount, mode)));
    }
    else if (s.status === "done") {
      fetch(`/api/jobs/${id}`, { method: "DELETE" }).catch(() => {});
      // A limited coupon just lost a use: show what is left (or drop it when none is).
      if (coupon && state.coupon?.code === coupon && state.coupon.uses_left !== null) applyCoupon(coupon);
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

// Returns { markdown, gpu, empty, layout } where gpu is "unneeded", "done", or why the pages the
// browser couldn't read stayed that way: "offline" (no worker / Device only), "too_big" (over the
// upload limit), "too_many" (over state.maxPages) or "failed". empty/layout list those pages.
async function convert(item, label, onDraft, signal) {
  const local = await convertLocal(item, label, signal);
  if (item.kind !== "pdf") return { markdown: local, gpu: "unneeded" };
  const { SCANNED_PAGE, NEEDS_GPU } = await import("./pdf-local.js");
  const pages = splitPages(local);
  const all = [...pages.keys()];
  // Pages the browser could not read (scans) or could only guess the layout of (columns).
  const empty = all.filter((n) => pages.get(n).endsWith(SCANNED_PAGE));
  const layout = all.filter((n) => pages.get(n).endsWith(NEEDS_GPU));
  const scanned = [...empty, ...layout];
  // Best quality redoes every page, unless that is over the GPU limit: then only the scans.
  const best = mode() === "best" && all.length <= state.maxPages;
  const target = best ? all : scanned;
  const missed = (why) => ({ markdown: local, gpu: scanned.length ? why : "unneeded", empty, layout });
  if (!target.length) return { markdown: local, gpu: "unneeded" };
  if (!canUseGpu(item)) return missed(state.workerOnline && mode() !== "device" ? "too_big" : "offline");
  if (target.length > state.maxPages) return missed("too_many");
  onDraft(local);
  try {
    const gpu = await convertServer(item, label, best ? "precise" : "fast", best ? null : target, target.length, signal);
    return { markdown: replacePages(local, gpu), gpu: "done" };
  } catch (e) {
    if (!e.fallback) throw e;
    return missed("failed");
  }
}

// --- run + results -----------------------------------------------------
const mdName = (name) => name.replace(/\.(pdf|docx|pptx)$/i, ".md");

const outputOptions = () => ({ keepPages: $("keep-pages").checked, figures: $("figures").checked, htmlTables: $("html-tables").checked });

function outputs() {
  const opts = outputOptions();
  return state.results.map((r) => ({ name: r.name, pages: pageCount(r.raw), markdown: optimize(r.raw, opts) }));
}

function renderOutput() {
  const outs = outputs();
  const md = merge(outs, { source: $("source").checked });
  state.md = md;
  const lines = renderMarkdown($("output"), md);
  $("result-name").textContent = outs.length === 1 ? mdName(outs[0].name) : `merged-${outs.length}-documents.md`;
  const files = outs.length === 1 ? "" : ` · ${outs.length} files`;
  $("result-stats").textContent = `~${estimateTokens(md).toLocaleString()} tokens · ${lines.toLocaleString()} lines${files}`;
  $("download-zip").hidden = outs.length < 2;
}

// Shows the output from where a file starts (its <document> line when several are merged).
function jumpTo(name) {
  showTab("results");
  const tag = `<document name="${name.replace(/"/g, "'")}"`;
  const i = state.results.length > 1 ? Math.max(0, state.md.split("\n").findIndex((l) => l.startsWith(tag))) : 0;
  const line = $("output").children[i];
  $("result").scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("output").scrollTo({ top: line ? line.offsetTop - 12 : 0, behavior: "smooth" });
  line?.classList.add("flash");
  setTimeout(() => line?.classList.remove("flash"), 1200);
}

// Pages the browser couldn't read and the GPU didn't redo, per file, above the output.
const pageList = (ns) => ns.reduce((out, n, i) => {
  if (i && n === ns[i - 1] + 1) out[out.length - 1][1] = n; else out.push([n, n]);
  return out;
}, []).map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ");
const count = (n, what) => `${n} ${what}${n > 1 ? "s" : ""}`;
const WHY = {
  offline: () => (mode() === "device" ? "Device only is on, so they weren't sent to the GPU." : "The GPU is resting right now; try again later."),
  too_big: () => `The file is over ${state.maxMb} MB, the most the GPU accepts${state.coupon ? "" : " (a coupon raises this)"}.`,
  too_many: () => `That's more than the ${state.maxPages} pages the GPU takes per file${state.coupon ? "" : " (a coupon raises this)"}.`,
  failed: () => "The GPU couldn't finish them; try again.",
};

function renderNotice(warnings) {
  $("notice").hidden = !warnings.length;
  $("notice-list").replaceChildren(...warnings.map((w) => {
    const parts = [];
    if (w.empty.length) parts.push(`${count(w.empty.length, "scanned page")} came out empty (p. ${pageList(w.empty)})`);
    if (w.layout.length) parts.push(`${count(w.layout.length, "multi-column page")} may be out of order (p. ${pageList(w.layout)})`);
    const li = document.createElement("li");
    li.append(Object.assign(document.createElement("strong"), { textContent: w.name }), ` · ${parts.join("; ")}. ${WHY[w.gpu]()}`);
    return li;
  }));
}

const SCANNED_NOTE = /\[scanned page: no text layer\]/g;

async function run() {
  if (!state.items.length || state.busy) return;
  state.busy = true;
  state.results = [];
  const controller = new AbortController();
  state.abort = controller;
  setMessage("");
  let failed = 0;
  let halted = false;
  const warnings = state.warnings = [];
  renderNotice([]);
  for (const item of state.items) { item.status = ""; item.info = "waiting"; item.progress = 0; }
  renderFiles();
  // The beaver keeps the Results tab company until the first Markdown arrives.
  $("result").hidden = true;
  $("empty").hidden = false;
  $("empty-title").textContent = "Gnawing…";
  $("empty-text").textContent = "The Markdown shows up here as soon as the first file is done.";
  showTab("results");

  const showResults = () => {
    renderOutput();
    $("empty").hidden = true;
    $("result").hidden = false;
    showTab("results");
  };

  for (const [i, item] of state.items.entries()) {
    if (controller.signal.aborted) { halted = true; item.info = "stopped"; continue; }
    const label = state.items.length > 1 ? `${i + 1}/${state.items.length} ${item.file.name}` : item.file.name;
    item.status = "busy"; item.info = "converting"; renderFiles();
    const result = { name: item.file.name, raw: "" };
    // The browser draft is shown while the GPU redoes pages; its result then replaces the draft.
    const onDraft = (draft) => {
      result.raw = draft;
      if (!state.results.includes(result)) state.results.push(result);
      item.info = "draft ready · GPU working"; renderFiles();
      // A draft of only scanned pages has no text yet: the beaver stays until there is some.
      if (state.results.some((r) => optimize(r.raw).replace(SCANNED_NOTE, "").trim())) showResults();
    };
    try {
      const { markdown, gpu, empty, layout } = await convert(item, label, onDraft, controller.signal);
      result.raw = markdown;
      if (!state.results.includes(result)) state.results.push(result);
      const tokens = estimateTokens(optimize(markdown));
      item.status = gpu in WHY ? "warn" : "done"; item.info = `done · ${tokens.toLocaleString()} tokens`;
      if (gpu in WHY) { warnings.push({ name: item.file.name, gpu, empty, layout }); renderNotice(warnings); }
      setBar($("working-bar"), (i + 1) / state.items.length);
      showResults();
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
  const clean = !halted && !failed && !warnings.length;
  state.doneFor = clean ? inputsKey() : null;
  $("working").hidden = true;
  renderFiles();
  if (state.results.length) showResults();
  else {
    $("empty-title").textContent = "Nothing here yet.";
    $("empty-text").textContent = "Add files and press Convert.";
  }
  const notes = [];
  if (halted) notes.push("Stopped. Files already converted are kept.");
  if (failed) notes.push(`${count(failed, "file")} couldn't be converted.`);
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
  try { await navigator.clipboard.writeText(state.md); }
  catch {
    const range = document.createRange();
    range.selectNodeContents($("output"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.execCommand("copy");
  }
  $("copy").textContent = "Copied";
  setTimeout(() => { $("copy").textContent = "Copy"; }, 1500);
});

$("download").addEventListener("click", () => {
  save(new Blob([state.md],{ type: "text/markdown;charset=utf-8" }), $("result-name").textContent);
});

$("download-zip").addEventListener("click", async () => {
  const zip = new window.JSZip();
  const used = new Set();
  for (const o of outputs()) {
    let name = mdName(o.name), n = 2;
    while (used.has(name)) name = mdName(o.name).replace(/\.md$/, `-${n++}.md`);
    used.add(name);
    zip.file(name, merge([o], { source: $("source").checked }));
  }
  save(await zip.generateAsync({ type: "blob" }), "mdbeaver-documents.zip");
});

refreshStatus();
setInterval(refreshStatus, 15000);
