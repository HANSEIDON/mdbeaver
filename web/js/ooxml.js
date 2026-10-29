// Shared helpers for Office Open XML files (PPTX, DOCX): zip parts,
// relationships, Office math → LaTeX, and grid tables → compact Markdown.
export const NS = {
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  m: "http://schemas.openxmlformats.org/officeDocument/2006/math",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
};
const MAX_UNCOMPRESSED = 300 * 1024 * 1024;

export const parse = (xml) => new DOMParser().parseFromString(xml, "application/xml");
export const kids = (el, ns, name) => [...el.children].filter((c) => c.namespaceURI === NS[ns] && c.localName === name);
export const kid = (el, ns, name) => (el ? kids(el, ns, name)[0] : undefined);
export const attr = (el, name) => el?.getAttribute(name);
export const wval = (el) => el?.getAttributeNS(NS.w, "val") ?? el?.getAttribute("w:val");

export async function openZip(file) {
  const zip = await window.JSZip.loadAsync(file);
  let total = 0;
  zip.forEach((_, f) => { total += f._data?.uncompressedSize || 0; });
  if (total > MAX_UNCOMPRESSED) throw new Error("too_large");
  return zip;
}

export async function readXml(zip, path) {
  const f = zip.file(path);
  return f ? parse(await f.async("string")) : null;
}

function resolve(base, target) {
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

export async function rels(zip, partPath) {
  const doc = await readXml(zip, partPath.replace(/([^/]+)$/, "_rels/$1.rels"));
  const map = {};
  if (!doc) return map;
  for (const r of doc.getElementsByTagNameNS(NS.rel, "Relationship"))
    map[r.getAttribute("Id")] = { target: resolve(partPath, r.getAttribute("Target")), type: r.getAttribute("Type") };
  return map;
}

// --- Office math (OMML) → LaTeX, covering the common constructs ---------------
const group = (s) => (s.length === 1 ? s : `{${s}}`); // a^2, not {a}^{2}: fewer tokens

export function omml(el) {
  if (!el) return "";
  if (el.namespaceURI !== NS.m) return [...el.children].map(omml).join("");
  const arg = (name) => omml(kid(el, "m", name));
  const prop = (pr, name) => attr(kid(kid(el, "m", pr), "m", name), "m:val");
  switch (el.localName) {
    case "t": return el.textContent;
    case "f": return `\\frac{${arg("num")}}{${arg("den")}}`;
    case "sSup": return `${group(arg("e"))}^${group(arg("sup"))}`;
    case "sSub": return `${group(arg("e"))}_${group(arg("sub"))}`;
    case "sSubSup": return `${group(arg("e"))}_${group(arg("sub"))}^${group(arg("sup"))}`;
    case "rad": {
      const deg = arg("deg");
      return deg ? `\\sqrt[${deg}]{${arg("e")}}` : `\\sqrt{${arg("e")}}`;
    }
    case "d": {
      const delim = (c) => (c === "{" || c === "}" ? `\\${c}` : c || ".");
      const beg = prop("dPr", "begChr") ?? "(", end = prop("dPr", "endChr") ?? ")";
      return `\\left${delim(beg)}${kids(el, "m", "e").map(omml).join(",")}\\right${delim(end)}`;
    }
    case "nary": {
      const chr = prop("naryPr", "chr") ?? "∫";
      const op = { "∑": "\\sum", "∏": "\\prod", "∫": "\\int", "∬": "\\iint", "∮": "\\oint" }[chr] ?? chr;
      const sub = arg("sub"), sup = arg("sup");
      return `${op}${sub ? `_${group(sub)}` : ""}${sup ? `^${group(sup)}` : ""} ${arg("e")}`;
    }
    case "func": return `\\${arg("fName").trim()} ${arg("e")}`;
    case "bar": return `\\overline{${arg("e")}}`;
    case "acc": return `\\hat{${arg("e")}}`;
    case "rPr": case "ctrlPr": case "fPr": case "sSupPr": case "sSubPr": case "sSubSupPr":
    case "radPr": case "dPr": case "naryPr": case "funcPr": case "barPr": case "accPr": return "";
    default: return [...el.children].map(omml).join("");
  }
}

export function mathIn(el) {
  return [...el.getElementsByTagNameNS(NS.m, "oMath")].map((m) => `$${omml(m).trim()}$`);
}

// --- tables --------------------------------------------------------------
// grid: rows of cell strings, merged areas already filled with the origin value.
// Tables with merged cells go out as HTML so the spans survive; optimize() flattens them to
// Markdown unless the user keeps merged tables as HTML. `cells` are the origin cells per row.
export function tableOut(grid, cells) {
  if (!cells.some((row) => row.some((c) => c.cs > 1 || c.rs > 1))) return gridToMarkdown(grid);
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const td = (c) => `<td${c.cs > 1 ? ` colspan="${c.cs}"` : ""}${c.rs > 1 ? ` rowspan="${c.rs}"` : ""}>${esc(c.text.replace(/\s+/g, " ").trim())}</td>`;
  return ["<table>", ...cells.map((row) => `<tr>${row.map(td).join("")}</tr>`), "</table>"].join("\n");
}

export function gridToMarkdown(grid) {
  const width = Math.max(0, ...grid.map((r) => r.length));
  if (!width) return "";
  const clean = (s) => (s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const row = (r) => `|${Array.from({ length: width }, (_, i) => clean(r[i])).join("|")}|`;
  return [row(grid[0]), `|${Array(width).fill("-").join("|")}|`, ...grid.slice(1).map(row)].join("\n");
}
