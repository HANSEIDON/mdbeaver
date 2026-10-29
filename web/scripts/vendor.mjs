// Copies third-party browser libraries into web/vendor so the site serves
// everything from its own origin (no external CDNs — they are slow or blocked in mainland China).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  "node_modules/pdfjs-dist/build/pdf.min.mjs": "vendor/pdf.min.mjs",
  "node_modules/pdfjs-dist/build/pdf.worker.min.mjs": "vendor/pdf.worker.min.mjs",
  "node_modules/jszip/dist/jszip.min.js": "vendor/jszip.min.js",
};

mkdirSync(join(root, "vendor"), { recursive: true });
for (const [src, dst] of Object.entries(files)) {
  copyFileSync(join(root, src), join(root, dst));
  console.log(`vendored ${dst}`);
}
