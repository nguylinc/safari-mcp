#!/usr/bin/env node
/**
 * The network and recording tools' page code (page-scripts.js) runs compiled into the extension, past a page's CSP:
 * background.js carries a generated copy that must match, page_script runs the steps in order, and the string form,
 * for an older extension, does the same.
 *
 * Run:  node --test --test-force-exit test/page-scripts.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { EXTENSION_BLOCK_END, EXTENSION_BLOCK_START, extensionBlock, pageScriptSource } from "../page-scripts.js";
import { recorderSteps, recordingReadSteps } from "../safari.js";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const block = background.slice(background.indexOf(EXTENSION_BLOCK_START), background.indexOf(EXTENSION_BLOCK_END) + EXTENSION_BLOCK_END.length);

test("background.js carries the current page scripts (else: node scripts/sync-page-scripts.mjs, and rebuild the extension)", () => {
  assert.equal(block, extensionBlock());
});

test("background.js routes page_script to the generated runner", () => {
  assert.match(background, /case "page_script": \{[\s\S]{0,200}_runPageScripts\(/);
});

// A jsdom page; execInTab, as the extension has it, calls the function with its arguments in the page.
function page() {
  const dom = new JSDOM(`<!doctype html><body><button>Go</button></body>`, { url: "https://example.test/", runScripts: "outside-only", pretendToBeVisual: true });
  const calls = [];
  const execInTab = async (fn, args, tabId) => {
    calls.push([fn.name, tabId]);
    return dom.window.eval(`(${fn})`).apply(null, args);
  };
  const context = vm.createContext({ execInTab, Object, Array, Error });
  vm.runInContext(`${block}\nthis._runPageScripts = _runPageScripts;`, context);
  return { dom, calls, run: (steps) => context._runPageScripts(7, steps) };
}

test("page_script runs the steps in order in the tab, and answers with the last one's value", async () => {
  const { dom, calls, run } = page();
  const answer = await run(recorderSteps(undefined, { network: true }));
  assert.match(answer, /^recording /);
  assert.deepEqual(calls, [["networkCapture", 7], ["pageIndicator", 7], ["pageRecorder", 7]]);
  dom.window.document.querySelector("button").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
  const read = JSON.parse(await run(recordingReadSteps({ limit: 10 })));
  assert.deepEqual([read.recording, read.network, read.steps.filter((s) => s.type === "click").length], [true, true, 1]);
  assert.match(await run(recorderSteps("stop")), /^stopped: /);
});

test("an unknown page script is refused, not looked up on the object's prototype", async () => {
  const { run } = page();
  await assert.rejects(run([["toString"]]), /Unknown page script: toString/);
  await assert.rejects(run([]), /needs steps/);
});

test("the string form, for an extension without page_script, runs the same steps", () => {
  const dom = new JSDOM(`<!doctype html><body></body>`, { url: "https://example.test/", runScripts: "outside-only", pretendToBeVisual: true });
  assert.match(dom.window.eval(pageScriptSource(recorderSteps(undefined, { network: false }))), /^recording /);
  assert.equal(dom.window.__mcp_network, undefined, "network: false installs no capture");
  assert.throws(() => pageScriptSource([["nope"]]), /Unknown page script/);
});

// The read-only inspection tools: safari_get_computed_style and the others that ran only through AppleScript, which
// reaches only the profile window's own tabs.
const INSPECT_PAGE = `<!doctype html><html lang="en"><head><title>Inspect</title>
  <meta name="description" content="A page"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta property="og:title" content="OG"><link rel="manifest" href="/m.json"></head>
  <body style="color: rgb(1, 2, 3)"><h1>Head</h1>
  <table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>apple</td><td>3</td></tr></tbody></table>
  <a href="/in">Inside</a><a href="https://other.test/x" rel="nofollow">Out</a><img src="/a.png"><form></form></body></html>`;
const INSPECT_STEPS = {
  computedStyleSteps: (s) => s.computedStyleSteps({ selector: "body", properties: ["color"] }),
  performanceMetricsSteps: (s) => s.performanceMetricsSteps(),
  extractTablesSteps: (s) => s.extractTablesSteps({}),
  extractMetaSteps: (s) => s.extractMetaSteps(),
  extractImagesSteps: (s) => s.extractImagesSteps({}),
  extractLinksSteps: (s) => s.extractLinksSteps({ filter: "other" }),
  inspectViewportSteps: (s) => s.inspectViewportSteps(),
  checkPWASteps: (s) => s.checkPWASteps(),
  analyzePageSteps: (s) => s.analyzePageSteps(),
};

function inspectPage() {
  const dom = new JSDOM(INSPECT_PAGE, { url: "https://example.test/", runScripts: "outside-only", pretendToBeVisual: true });
  // jsdom has no performance entries by type, nor innerText.
  dom.window.eval("performance.getEntriesByType = function () { return []; }; Object.defineProperty(HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });");
  const execInTab = async (fn, args) => dom.window.eval(`(${fn})`).apply(null, args);
  const context = vm.createContext({ execInTab, Object, Array, Error });
  vm.runInContext(`${block}\nthis._runPageScripts = _runPageScripts;`, context);
  return { dom, run: (steps) => context._runPageScripts(7, steps) };
}

test("the inspection tools' page scripts answer through page_script, and as the one-line AppleScript string", async () => {
  const safari = await import("../safari.js");
  const { dom, run } = inspectPage();
  for (const [name, stepsOf] of Object.entries(INSPECT_STEPS)) {
    const steps = stepsOf(safari);
    const compiled = JSON.parse(await run(steps));
    // runJS flattens a script to one line: a page script that leans on a line break breaks there.
    const oneLine = pageScriptSource(steps).replace(/^\s*\/\/[^\n]*$/gm, "").replace(/\n/g, " ");
    assert.deepEqual(JSON.parse(dom.window.eval(oneLine)), compiled, name);
  }
  const answer = async (stepsOf) => JSON.parse(await run(stepsOf(safari)));
  assert.deepEqual(await answer(INSPECT_STEPS.computedStyleSteps), { color: "rgb(1, 2, 3)" });
  assert.deepEqual(JSON.parse(await run(safari.computedStyleSteps({ selector: "#none" }))), { error: "Element not found" });
  const [table] = await answer(INSPECT_STEPS.extractTablesSteps);
  assert.deepEqual([table.headers, table.rows.at(-1)], [["Name", "Qty"], ["apple", "3"]]);
  assert.deepEqual((await answer(INSPECT_STEPS.extractLinksSteps)).map((l) => [l.text, l.isExternal, l.isNofollow]), [["Out", true, true]]);
  const meta = await answer(INSPECT_STEPS.extractMetaSteps);
  assert.deepEqual([meta.title, meta.description, meta.og.title, meta.language], ["Inspect", "A page", "OG", "en"]);
  assert.equal((await answer(INSPECT_STEPS.extractImagesSteps)).length, 1);
  assert.equal((await answer(INSPECT_STEPS.inspectViewportSteps)).attrs.width, "device-width");
  assert.equal((await answer(INSPECT_STEPS.checkPWASteps)).total, 6);
  const analysis = await answer(INSPECT_STEPS.analyzePageSteps);
  assert.deepEqual([analysis.headings.h1, analysis.links, analysis.forms], [["Head"], { internal: 1, external: 1, nofollow: 1 }, 1]);
  assert.equal((await answer(INSPECT_STEPS.performanceMetricsSteps)).resources.total, 0);
});

test("the IndexedDB page scripts answer a page without indexedDB.databases() with an error, not a throw", async () => {
  const safari = await import("../safari.js");
  const { run } = inspectPage();
  assert.match(await run(safari.listIndexedDBsSteps()), /not supported/);
});

test("the inspection tools go to page_script, with AppleScript only as the fallback, and take a receipt", () => {
  const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const tools = {
    safari_get_computed_style: ["computedStyleSteps", "getComputedStyles"],
    safari_performance_metrics: ["performanceMetricsSteps", "getPerformanceMetrics"],
    safari_extract_tables: ["extractTablesSteps", "extractTables"],
    safari_extract_meta: ["extractMetaSteps", "extractMeta"],
    safari_extract_images: ["extractImagesSteps", "extractImages"],
    safari_extract_links: ["extractLinksSteps", "extractLinks"],
    safari_list_indexed_dbs: ["listIndexedDBsSteps", "listIndexedDBs"],
    safari_get_indexed_db: ["indexedDBSteps", "getIndexedDB"],
    safari_inspect_viewport: ["inspectViewportSteps", "inspectViewport"],
    safari_check_pwa: ["checkPWASteps", "checkPWA"],
    safari_analyze_page: ["analyzePageSteps", "analyzePage"],
  };
  for (const [name, [steps, fallback]] of Object.entries(tools)) {
    const at = index.indexOf(`server.tool(\n  "${name}",`);
    assert.ok(at >= 0, name);
    const tool = index.slice(at, index.indexOf("\n);\n", at));
    assert.match(tool, /receipt: _RECEIPT_ARG/, name);
    assert.match(tool, new RegExp(`runPageSteps\\(safari\\.${steps}\\([^)]*\\), args, \\(\\) => safari\\.${fallback}\\(`), name);
  }
  // An extension built before these functions answers "Unknown page script": the same code then goes through evaluate.
  assert.match(index, /Unknown command: page_script\|Unknown page script: /);
});
