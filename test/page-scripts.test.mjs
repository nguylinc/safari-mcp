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
