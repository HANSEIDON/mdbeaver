import { estimateTokens, merge, optimize } from "./output.js";

const $ = (id) => document.getElementById(id);
const KINDS = { pdf: "PDF", docx: "DOCX", pptx: "PPTX" };
const state = { items: [], workerOnline: false, maxMb: 50, busy: false, results: [] };

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

const onServer = (item) => item.kind === "pdf" && state.workerOnline && !$("local-only").checked && item.file.size <= state.maxMb * 1048576;

function renderRoute() {
  if (state.busy) return;
  if (!state.items.length) { $("route").textContent = "Free · add documents to start"; return; }
  const server = state.items.some(onServer);
  $("route").textContent = `Free · ${state.items.length} file${state.items.length > 1 ? "s" : ""} · ${server ? "PDFs on our GPU server, the rest in your browser" : "runs in your browser"}`;
}

// --- tabs and options ---------------------------------------------------
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
  $("tab-config").hidden = name !== "config";
  $("tab-results").hidden = name !== "results";
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
$("local-only").addEventListener("change", renderRoute);
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
  $("run").disabled = state.busy || !state.items.length;
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

async function convertLocal(item, label) {
  const convert = await CONVERTERS[item.kind]();
  return convert(item.file, (f) => progress(`${label} · chewing in your browser`, f));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function convertServer(item, label) {
  progress(`${label} · uploading`);
  const form = new FormData();
  form.append("file", item.file);
  form.append("mode", "fast");
  const r = await fetch("/api/jobs", { method: "POST", body: form });
  if (!r.ok) {
    const err = new Error((await r.json().catch(() => ({}))).detail || `http_${r.status}`);
    err.fallback = [429, 502, 503, 504].includes(r.status);
    throw err;
  }
  const { id } = await r.json();
  for (;;) {
    await sleep(1500);
    const s = await (await fetch(`/api/jobs/${id}`, { cache: "no-store" })).json();
    if (s.status === "queued") progress(`${label} · in line #${s.position}`);
    else if (s.status === "running") progress(`${label} · the GPU beaver is chewing`);
    else if (s.status === "done") {
      fetch(`/api/jobs/${id}`, { method: "DELETE" }).catch(() => {});
      return s.markdown;
    } else throw new Error(s.error || "failed");
  }
}

async function convert(item, label) {
  if (!onServer(item)) return { markdown: await convertLocal(item, label), fellBack: false };
  try {
    return { markdown: await convertServer(item, label), fellBack: false };
  } catch (e) {
    if (!e.fallback) throw e;
    return { markdown: await convertLocal(item, label), fellBack: true };
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
  setMessage("");
  let failed = 0, fellBack = 0;
  for (const item of state.items) { item.status = ""; item.info = "waiting"; }
  renderFiles();

  for (const [i, item] of state.items.entries()) {
    const label = state.items.length > 1 ? `${i + 1}/${state.items.length} ${item.file.name}` : item.file.name;
    item.status = "busy"; item.info = "converting…"; renderFiles();
    try {
      const { markdown, fellBack: fb } = await convert(item, label);
      fellBack += fb ? 1 : 0;
      state.results.push({ name: item.file.name, raw: markdown });
      const tokens = estimateTokens(optimize(markdown));
      item.status = "done"; item.info = `done · ~${tokens.toLocaleString()} tokens`;
    } catch (e) {
      failed++;
      item.status = "error"; item.info = `failed (${e.message || e})`;
    }
    renderFiles();
  }

  state.busy = false;
  $("bar").hidden = true;
  renderFiles();
  if (state.results.length) {
    renderOutput();
    $("empty").hidden = true;
    $("result").hidden = false;
    showTab("results");
  }
  const notes = [];
  if (failed) notes.push(`${failed} file${failed > 1 ? "s" : ""} couldn't be converted.`);
  if (fellBack) notes.push("Our server was busy, so some PDFs ran in your browser.");
  setMessage(notes.join(" "), failed > 0);
}
$("run").addEventListener("click", run);

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

refreshStatus();
setInterval(refreshStatus, 15000);
