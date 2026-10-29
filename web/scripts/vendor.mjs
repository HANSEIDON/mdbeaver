// Copies third-party browser libraries into web/vendor so the site serves
// everything from its own origin (no external CDNs — they are slow or blocked in mainland China).
import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  "node_modules/pdfjs-dist/build/pdf.min.mjs": "vendor/pdf.min.mjs",
  "node_modules/pdfjs-dist/build/pdf.worker.min.mjs": "vendor/pdf.worker.min.mjs",
  "node_modules/jszip/dist/jszip.min.js": "vendor/jszip.min.js",
  // IBM Plex (OFL-1.1), Latin subsets; CJK text falls back to system fonts.
  ...Object.fromEntries([["sans", 400], ["sans", 500], ["sans", 600], ["mono", 400], ["mono", 500]].map(([f, w]) => [
    `node_modules/@fontsource/ibm-plex-${f}/files/ibm-plex-${f}-latin-${w}-normal.woff2`,
    `vendor/fonts/plex-${f}-${w}.woff2`,
  ])),
};

// pdf.js data it fetches on demand: CMaps (without them, PDFs whose CJK fonts use predefined
// encodings come out with every Chinese/Japanese/Korean character missing) and standard fonts.
const dirs = {
  "node_modules/pdfjs-dist/cmaps": "vendor/cmaps",
  "node_modules/pdfjs-dist/standard_fonts": "vendor/standard_fonts",
};

mkdirSync(join(root, "vendor", "fonts"), { recursive: true });
for (const [src, dst] of Object.entries(files)) {
  copyFileSync(join(root, src), join(root, dst));
  console.log(`vendored ${dst}`);
}
for (const [src, dst] of Object.entries(dirs)) {
  cpSync(join(root, src), join(root, dst), { recursive: true });
  console.log(`vendored ${dst}/`);
}
