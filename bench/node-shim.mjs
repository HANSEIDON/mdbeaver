// Lets the browser converters in web/js run unchanged under Node:
// - maps the site's absolute /vendor/ imports to the pdf.js legacy (Node) build
// - provides DOMParser (jsdom) and window.JSZip, which the converters expect as globals
import { register } from "node:module";
import { JSDOM } from "jsdom";
import JSZip from "jszip";

register("./vendor-hook.mjs", import.meta.url);

const { window } = new JSDOM("");
globalThis.DOMParser = window.DOMParser;
globalThis.window = { JSZip };
// pdf-local.js loads CMaps/standard fonts from "/vendor/" on the site; under Node, from pdfjs-dist.
globalThis.MDB_PDFJS_ASSETS = new URL("./node_modules/pdfjs-dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// Minimal File stand-in: a Uint8Array (JSZip reads it directly) with arrayBuffer() for pdf.js.
globalThis.BenchFile = class BenchFile extends Uint8Array {
  // subarray()/slice() must return plain Uint8Arrays, not call this constructor.
  static get [Symbol.species]() {
    return Uint8Array;
  }
  constructor(bytes, name) {
    super(bytes);
    this.name = name;
  }
  async arrayBuffer() {
    return this.buffer.slice(this.byteOffset, this.byteOffset + this.byteLength);
  }
  get size() {
    return this.byteLength;
  }
};
