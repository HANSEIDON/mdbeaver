// Browser-side HWP (Hangul 5.x binary) → Markdown. An HWP file is a Compound File (the old
// Office container) holding deflate-compressed record streams: DocInfo (paragraph shapes) and
// BodyText/SectionN (paragraphs, tables, equations, text boxes, notes). Running headers and
// footers are left out, like the PDF path drops them. Copy-protected ("distribution") and
// password-protected files are encrypted and cannot be read.
import { tableOut } from "./ooxml.js";
import { hwpEquation } from "./hwp-eq.js";

// --- Compound File Binary ------------------------------------------------
const FREE = 0xffffffff, END = 0xfffffffe;

function readCfb(buf) {
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== 0xe011cfd0 || v.getUint32(4, true) !== 0xe11ab1a1) throw new Error("not_hwp");
  const size = 1 << v.getUint16(30, true);
  const miniSize = 1 << v.getUint16(32, true);
  const cutoff = v.getUint32(56, true);
  const sector = (n) => (n + 1) * size;
  const per = size / 4;

  const fatSectors = [];
  for (let i = 0; i < 109; i++) { const s = v.getUint32(76 + i * 4, true); if (s !== FREE) fatSectors.push(s); }
  for (let s = v.getUint32(68, true), guard = 0; s !== END && s !== FREE && guard++ < 1e5;) {
    for (let i = 0; i < per - 1; i++) { const x = v.getUint32(sector(s) + i * 4, true); if (x !== FREE) fatSectors.push(x); }
    s = v.getUint32(sector(s) + (per - 1) * 4, true);
  }
  const fat = new Uint32Array(fatSectors.length * per);
  fatSectors.forEach((s, i) => fat.set(new Uint32Array(buf.slice(sector(s), sector(s) + size)), i * per));

  const chain = (start, table) => {
    const out = [];
    for (let s = start; s !== END && s < table.length && out.length <= table.length; s = table[s]) out.push(s);
    return out;
  };
  const read = (start, length) => {
    const out = new Uint8Array(chain(start, fat).length * size);
    chain(start, fat).forEach((s, i) => out.set(new Uint8Array(buf, sector(s), Math.min(size, buf.byteLength - sector(s))), i * size));
    return out.subarray(0, length ?? out.length);
  };

  const dirBytes = read(v.getUint32(48, true));
  const dv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const entries = [];
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const nameLen = dv.getUint16(o + 64, true);
    entries.push({
      name: String.fromCharCode(...new Uint16Array(dirBytes.buffer.slice(dirBytes.byteOffset + o, dirBytes.byteOffset + o + Math.max(0, nameLen - 2)))),
      type: dirBytes[o + 66], left: dv.getUint32(o + 68, true), right: dv.getUint32(o + 72, true),
      child: dv.getUint32(o + 76, true), start: dv.getUint32(o + 116, true), size: dv.getUint32(o + 120, true),
    });
  }
  const root = entries[0];
  const miniStream = read(root.start, root.size);
  const miniFat = new Uint32Array(read(v.getUint32(60, true)).slice().buffer);

  // Every stream by its path ("BodyText/Section0"), walking each storage's red-black tree.
  const streams = new Map();
  const walk = (id, prefix, seen = new Set()) => {
    if (id === FREE || id >= entries.length || seen.has(id)) return;
    seen.add(id);
    const e = entries[id];
    walk(e.left, prefix, seen);
    walk(e.right, prefix, seen);
    if (e.type === 1) walk(e.child, `${prefix}${e.name}/`, seen);
    else if (e.type === 2) streams.set(prefix + e.name, e);
  };
  walk(root.child, "");

  return {
    names: [...streams.keys()],
    get(path) {
      const e = streams.get(path);
      if (!e) return null;
      if (e.size >= cutoff) return read(e.start, e.size);
      const out = new Uint8Array(e.size);
      let o = 0;
      for (const s of chain(e.start, miniFat)) {
        const n = Math.min(miniSize, e.size - o);
        out.set(miniStream.subarray(s * miniSize, s * miniSize + n), o);
        o += n;
      }
      return out;
    },
  };
}

// Hangul often leaves padding after the deflate data, which the decompressor rejects once the
// real data is out: keep what came before it.
async function inflate(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks = [];
  try {
    for (let r; !(r = await reader.read()).done;) chunks.push(r.value);
  } catch (e) {
    if (!chunks.length) throw e;
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// --- records ---------------------------------------------------------------
const TAG = {
  PARA_SHAPE: 25, PARA_HEADER: 66, PARA_TEXT: 67, CTRL_HEADER: 71, LIST_HEADER: 72, TABLE: 77,
  PICTURE: 85, OLE: 84, EQEDIT: 88, CHART: 95,
};

// Flat records → tree by level: a record's children are the deeper records right after it.
function records(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const root = { level: -1, children: [] };
  const stack = [root];
  for (let o = 0; o + 4 <= bytes.length;) {
    const h = v.getUint32(o, true);
    let size = h >>> 20;
    o += 4;
    if (size === 0xfff) { size = v.getUint32(o, true); o += 4; }
    const rec = { tag: h & 0x3ff, level: (h >>> 10) & 0x3ff, data: bytes.subarray(o, o + size), children: [] };
    o += size;
    while (stack.length > 1 && stack[stack.length - 1].level >= rec.level) stack.pop();
    stack[stack.length - 1].children.push(rec);
    stack.push(rec);
  }
  return root.children;
}

const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const ctrlId = (rec) => String.fromCharCode(rec.data[3], rec.data[2], rec.data[1], rec.data[0]);

// Paragraph shapes in DocInfo order: id → { kind: 0 none, 1 outline (heading), 2 number, 3 bullet; level }.
function paraShapes(docInfo) {
  const shapes = [];
  const visit = (recs) => {
    for (const r of recs) {
      if (r.tag === TAG.PARA_SHAPE && r.data.length >= 4) {
        const p = u32(r.data, 0);
        shapes.push({ kind: (p >>> 23) & 3, level: (p >>> 25) & 7 });
      }
      visit(r.children);
    }
  };
  visit(docInfo);
  return shapes;
}

// --- body ------------------------------------------------------------------
// Control characters in PARA_TEXT: these take one character, all others below 32 take eight
// (an inline or extended control; each extended one has a CTRL_HEADER, in order).
const SHORT = new Set([0, 10, 13, 24, 30, 31]);
const EXTENDED = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);
const SKIP_CTRL = new Set(["head", "foot", "secd", "cold", "pgnp", "pghd", "pgct", "atno", "nwno", "bokm", "idxm", "tcmt", "tdut", "tcps"]);

function makeReader(shapes) {
  const notes = [];

  // A run of sibling records holding paragraphs → Markdown lines.
  function paragraphs(recs) {
    const out = [];
    for (const r of recs) if (r.tag === TAG.PARA_HEADER) { const p = paragraph(r); if (p) out.push(p); }
    return out;
  }

  function paragraph(header) {
    const textRec = header.children.find((c) => c.tag === TAG.PARA_TEXT);
    const ctrls = header.children.filter((c) => c.tag === TAG.CTRL_HEADER);
    const blocks = []; // tables and other block content go after the paragraph's text
    let s = "";
    if (textRec) {
      const d = textRec.data;
      let ci = 0;
      for (let i = 0; i + 1 < d.length;) {
        const c = u16(d, i);
        if (c >= 32) { s += String.fromCharCode(c); i += 2; continue; }
        if (SHORT.has(c)) {
          if (c === 10 || c === 30 || c === 31) s += " ";
          else if (c === 24) s += "-";
          i += 2;
          continue;
        }
        if (c === 9) s += " ";
        if (EXTENDED.has(c)) {
          const ctrl = ctrls[ci++];
          if (ctrl) {
            const { inline, block } = control(ctrl);
            s += inline;
            if (block) blocks.push(block);
          }
        }
        i += 16;
      }
    }
    const text = s.replace(/\s+/g, " ").trim();
    const shape = shapes[u16(header.data, 8)];
    let line = text;
    if (text && shape?.kind === 1) line = `${"#".repeat(Math.min(6, shape.level + 1))} ${text}`;
    else if (text && (shape?.kind === 2 || shape?.kind === 3)) line = `${"  ".repeat(shape.level)}- ${text}`;
    return [line, ...blocks].filter(Boolean).join("\n\n");
  }

  // One extended control → { inline text, block Markdown }.
  function control(ctrl) {
    const id = ctrlId(ctrl);
    if (SKIP_CTRL.has(id)) return { inline: "" };
    if (id === "tbl ") return { inline: "", block: table(ctrl) };
    if (id === "eqed") {
      const eq = find(ctrl, TAG.EQEDIT);
      const script = eq ? equationScript(eq.data) : "";
      return { inline: script ? ` $${hwpEquation(script)}$ ` : "" };
    }
    if (id === "fn  " || id === "en  ") {
      const text = paragraphs(listBody(ctrl)).join(" ");
      if (!text) return { inline: "" };
      notes.push(text);
      return { inline: `[^${notes.length}]` };
    }
    // Drawing objects: text boxes keep their text; pictures, charts and OLE objects leave a marker.
    const inner = paragraphs(listBody(ctrl)).join("\n\n");
    const figure = find(ctrl, TAG.PICTURE) || find(ctrl, TAG.OLE) || find(ctrl, TAG.CHART);
    return { inline: "", block: [figure ? "<!-- figure -->" : "", inner].filter(Boolean).join("\n\n") };
  }

  // Paragraphs of every list (text box, note) under a control, in order.
  function listBody(rec) {
    const out = [];
    const visit = (r) => {
      for (const c of r.children) {
        if (c.tag === TAG.PARA_HEADER) out.push(c);
        else if (c.tag !== TAG.CTRL_HEADER) visit(c);
      }
    };
    visit(rec);
    return out;
  }

  // TABLE gives the size; each cell is a LIST_HEADER (address and span) followed by its paragraphs.
  function table(ctrl) {
    const t = ctrl.children.find((c) => c.tag === TAG.TABLE);
    if (!t) return "";
    const rows = u16(t.data, 4), cols = u16(t.data, 6);
    const grid = Array.from({ length: rows }, () => Array(cols).fill(""));
    const cells = Array.from({ length: rows }, () => []);
    let cell = null;
    const flush = () => {
      if (!cell) return;
      const text = cell.paras.map(paragraph).filter(Boolean).join(" ").replace(/\n+/g, " ");
      const { col, row, cs, rs } = cell;
      if (row < rows && col < cols) {
        cells[row].push({ col, text, cs, rs });
        for (let r = row; r < Math.min(rows, row + rs); r++)
          for (let c = col; c < Math.min(cols, col + cs); c++) grid[r][c] = text;
      }
    };
    for (const c of ctrl.children) {
      if (c.tag === TAG.LIST_HEADER) {
        flush();
        const d = c.data;
        cell = { col: u16(d, 8), row: u16(d, 10), cs: Math.max(1, u16(d, 12)), rs: Math.max(1, u16(d, 14)), paras: [] };
      } else if (c.tag === TAG.PARA_HEADER && cell) cell.paras.push(c);
    }
    flush();
    // A one-cell table is a box around text (a cover title, a note), not data; an empty one is layout.
    if (rows * cols === 1) return grid[0][0];
    if (grid.every((row) => row.every((c) => !c))) return "";
    for (const row of cells) row.sort((a, b) => a.col - b.col);
    return tableOut(grid, cells);
  }

  return { paragraphs, notes };
}

function find(rec, tag) {
  for (const c of rec.children) {
    if (c.tag === tag) return c;
    const hit = find(c, tag);
    if (hit) return hit;
  }
  return null;
}

// EQEDIT: property (4 bytes), then the script as a length-prefixed UTF-16 string.
function equationScript(d) {
  const n = u16(d, 4);
  let s = "";
  for (let i = 0; i < n && 6 + i * 2 + 1 < d.length; i++) s += String.fromCharCode(u16(d, 6 + i * 2));
  return s.trim();
}

export async function hwpToMarkdown(file, onProgress) {
  const cfb = readCfb(await file.arrayBuffer());
  const head = cfb.get("FileHeader");
  if (!head || !new TextDecoder().decode(head.subarray(0, 17)).startsWith("HWP Document File")) throw new Error("not_hwp");
  const flags = u32(head, 36);
  if (flags & 2) throw new Error("hwp_password");
  if (flags & 4) throw new Error("hwp_distribution");
  const compressed = !!(flags & 1);
  const load = async (path) => { const b = cfb.get(path); return b && (compressed ? inflate(b) : b); };

  const reader = makeReader(paraShapes(records(await load("DocInfo") || new Uint8Array())));
  const sections = cfb.names.filter((n) => /^BodyText\/Section\d+$/.test(n)).sort((a, b) => a.match(/\d+$/)[0] - b.match(/\d+$/)[0]);
  if (!sections.length) throw new Error("not_hwp");
  const out = [];
  for (const [i, name] of sections.entries()) {
    for (const p of reader.paragraphs(records(await load(name)))) out.push(p); // can be 100k+: no spread
    onProgress?.((i + 1) / sections.length);
  }
  if (reader.notes.length) out.push(reader.notes.map((n, i) => `[^${i + 1}]: ${n}`).join("\n"));
  return out.join("\n\n").replace(/^(\s*- .*)\n\n(?=\s*- )/gm, "$1\n") + "\n";
}
