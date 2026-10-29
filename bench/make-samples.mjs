// Generates small synthetic documents in bench/samples for a smoke test of the
// benchmark (real measurements should use real documents in bench/docs).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";

const OUT = join(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "samples");

function pdf(pages) {
  const objs = [];
  const add = (s) => objs.push(s);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const streams = pages.map((lines) => {
    const c = lines.map(([size, y, text]) => `BT /F1 ${size} Tf 72 ${y} Td (${text}) Tj ET`).join(" ");
    add(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
    return objs.length;
  });
  const pagesId = objs.length + streams.length + 1;
  const pageIds = streams.map((s) => {
    add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${s} 0 R /Resources << /Font << /F1 1 0 R >> >> >>`);
    return objs.length;
  });
  add(`<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${objs.length} 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const body = "The beaver builds dams to slow the river and store food for the winter season.";
const pdfPages = Array.from({ length: 12 }, (_, i) => [
  [9, 760, "Annual Beaver Report 2026 - Confidential"],
  ...(i % 4 === 0 ? [[22, 700, `Chapter ${i / 4 + 1}`]] : [[15, 700, `Section ${i + 1}`]]),
  ...Array.from({ length: 8 }, (_, j) => [11, 670 - j * 15, `${body} (${i + 1}.${j + 1})`]),
  [9, 40, `Page ${i + 1} of 12`],
]);

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
const para = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const docxXml = `<w:document ${W}><w:body>
${para("비버 연구 보고서", "Heading1")}
${Array.from({ length: 6 }, (_, i) => para(`비버는 댐을 지어 물의 흐름을 늦추고 겨울을 대비해 먹이를 저장합니다. 문단 ${i + 1}.`)).join("")}
${para("河狸的栖息地", "Heading2")}
${Array.from({ length: 6 }, (_, i) => para(`河狸修建水坝以减缓水流，并为冬季储存食物。第${i + 1}段。`)).join("")}
<w:tbl>${[["지역", "개체 수", "증감"], ["강원", "120", "+4%"], ["경기", "85", "-2%"]].map((r) => `<w:tr>${r.map((c) => `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>
<w:p><m:oMath><m:f><m:num><m:r><m:t>dN</m:t></m:r></m:num><m:den><m:r><m:t>dt</m:t></m:r></m:den></m:f><m:r><m:t>=rN</m:t></m:r></m:oMath></w:p>
</w:body></w:document>`;
const docxStyles = `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`;

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const slide = (title, bullets) => `<p:sld ${P}><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="B"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${bullets.map((b) => `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;

async function zip(files) {
  const z = new JSZip();
  for (const [path, content] of Object.entries(files)) z.file(path, content);
  return z.generateAsync({ type: "nodebuffer" });
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "sample-en-report.pdf"), pdf(pdfPages));
await writeFile(join(OUT, "sample-ko-zh.docx"), await zip({ "word/document.xml": docxXml, "word/styles.xml": docxStyles }));
const slides = ["Why beavers matter", "Dam engineering", "Population trends", "Next steps"];
await writeFile(join(OUT, "sample-en-deck.pptx"), await zip({
  "ppt/presentation.xml": `<p:presentation ${P}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`,
  "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="x/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`,
  ...Object.fromEntries(slides.map((t, i) => [`ppt/slides/slide${i + 1}.xml`, slide(t, ["•   First point about beavers", "Second point", "Third point"])])),
}));
console.log(`samples written to ${OUT}`);
