#!/usr/bin/env node
/**
 * safari_start_recording's page recorder (page-recorder.js): what the user does becomes steps, each with a selector
 * ranked as Playwright's recorder ranks them and the safari-mcp call that replays it, and a password is never kept.
 *
 * Run:  node --test test/page-recorder.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { pageRecorder } from "../page-recorder.js";

// The recorder runs as page JavaScript: give it a jsdom page as its window and document.
function page(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: "https://example.test/start", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  pageRecorder();
  const { window } = dom;
  const fire = (el, type, init = {}) => {
    const Ctor = type.startsWith("key") ? window.KeyboardEvent : type === "input" || type === "change" || type === "submit" ? window.Event : window.MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  };
  return { window, document: window.document, fire, steps: () => window.__mcp_recording.steps.filter((s) => s.type !== "start") };
}

test("a click on a uniquely named button replays by its text; one without a name by a selector", () => {
  const { document, fire, steps } = page(`<button>Save</button><div class="row"><span>x</span></div><div class="row"><span>y</span></div>`);
  fire(document.querySelector("button"), "click", { button: 0, detail: 1 });
  fire(document.querySelectorAll(".row span")[1], "click", { button: 0, detail: 1 });
  const [save, span] = steps();
  assert.deepEqual([save.type, save.role, save.name, save.tool], ["click", "button", "Save", { name: "safari_click", args: { text: "Save" } }]);
  assert.equal(span.tool.name, "safari_click");
  assert.equal(document.querySelectorAll(span.tool.args.selector).length, 1);
  assert.equal(document.querySelector(span.tool.args.selector).textContent, "y");
});

test("a test id wins over everything else, then a stable id", () => {
  const { document, fire, steps } = page(`<button data-testid="submit-btn" id="b1">Go</button><button id="cancel">Go</button>`);
  fire(document.querySelector("[data-testid]"), "click", { button: 0, detail: 1 });
  fire(document.querySelector("#cancel"), "click", { button: 0, detail: 1 });
  assert.deepEqual(steps().map((s) => s.selector), ['[data-testid="submit-btn"]', "#cancel"]);
});

test("typing is one fill per field, with its latest value; a password's value is never kept", () => {
  const { document, fire, steps } = page(`<input placeholder="Search"><input type="password" name="pw">`);
  const search = document.querySelector("input[placeholder]");
  for (const v of ["a", "ab", "abc"]) { search.value = v; fire(search, "input"); }
  const pw = document.querySelector("[type=password]");
  pw.value = "hunter2"; fire(pw, "input");
  const [fill, secret] = steps();
  assert.deepEqual([fill.type, fill.value, fill.tool], ["fill", "abc", { name: "safari_fill", args: { selector: 'input[placeholder="Search"]', value: "abc" } }]);
  assert.equal(secret.value, null);
  assert.equal(secret.redacted, true);
  assert.equal(secret.tool.args.value, "<password>");
  assert.ok(!JSON.stringify(document.defaultView.__mcp_recording.steps).includes("hunter2"));
});

test("special keys and shortcuts become safari_press_key; plain letters don't", () => {
  const { document, fire, steps } = page(`<input aria-label="Comment">`);
  const field = document.querySelector("input");
  fire(field, "keydown", { key: "a" });
  fire(field, "keydown", { key: "Enter" });
  fire(field, "keydown", { key: "s", metaKey: true });
  const [enter, save] = steps();
  assert.deepEqual(enter.tool, { name: "safari_press_key", args: { key: "Enter" } });
  assert.deepEqual(save.tool, { name: "safari_press_key", args: { key: "s", modifiers: ["cmd"] } });
  assert.equal(steps().length, 2);
});

test("selects, checkboxes and double clicks", () => {
  const { document, fire, steps } = page(`<select name="size"><option value="s">Small</option><option value="l">Large</option></select>
    <input type="checkbox" id="agree"><button>Open</button>`);
  const select = document.querySelector("select");
  select.value = "l"; fire(select, "change");
  const box = document.querySelector("#agree");
  box.checked = true; fire(box, "change");
  const open = document.querySelector("button");
  fire(open, "click", { button: 0, detail: 1 });
  fire(open, "click", { button: 0, detail: 2 });
  const [sel, check, dbl] = steps();
  assert.deepEqual([sel.type, sel.value, sel.optionText, sel.tool.name], ["select", "l", "Large", "safari_select_option"]);
  assert.deepEqual([check.type, check.selector], ["check", "#agree"]);
  assert.deepEqual([dbl.type, dbl.tool.name], ["dblclick", "safari_double_click"]);
  assert.equal(steps().length, 3);
});

test("in-app navigation is a step; stopping keeps the steps and records nothing more", () => {
  const { window, document, fire, steps } = page(`<button>Next</button>`);
  window.history.pushState({}, "", "/page/2");
  assert.deepEqual(steps().at(-1).tool, { name: "safari_navigate", args: { url: "https://example.test/page/2" } });
  assert.match(pageRecorder("stop"), /stopped: \d+ steps kept/);
  fire(document.querySelector("button"), "click", { button: 0, detail: 1 });
  window.history.pushState({}, "", "/page/3");
  assert.equal(steps().length, 1);
});
