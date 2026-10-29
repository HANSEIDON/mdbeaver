// Module resolve hook: "/vendor/pdf*.mjs" (served by the website) → pdfjs-dist legacy build for Node.
const MAP = {
  "/vendor/pdf.min.mjs": "pdfjs-dist/legacy/build/pdf.mjs",
  "/vendor/pdf.worker.min.mjs": "pdfjs-dist/legacy/build/pdf.worker.mjs",
};

export async function resolve(specifier, context, next) {
  const target = MAP[specifier];
  return target ? next(target, { ...context, parentURL: import.meta.url }) : next(specifier, context);
}
