#!/usr/bin/env node
// Copies page-scripts.js's functions into extension/background.js (the block at its end), so the extension runs them
// compiled in, past a page's CSP. Run after changing page-scripts.js or page-recorder.js, then rebuild the extension.
//
//   node scripts/sync-page-scripts.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { EXTENSION_BLOCK_END, EXTENSION_BLOCK_START, extensionBlock } from "../page-scripts.js";

const path = new URL("../extension/background.js", import.meta.url);
const source = readFileSync(path, "utf8");
const start = source.indexOf(EXTENSION_BLOCK_START);
const end = source.indexOf(EXTENSION_BLOCK_END);
const next = start < 0
  ? source.replace(/\n*$/, "\n\n") + extensionBlock() + "\n"
  : source.slice(0, start) + extensionBlock() + source.slice(end + EXTENSION_BLOCK_END.length);
if (next === source) console.log("extension/background.js already has the current page scripts");
else {
  writeFileSync(path, next);
  console.log("updated the page scripts in extension/background.js: rebuild the extension");
}
