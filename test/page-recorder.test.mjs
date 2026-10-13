#!/usr/bin/env node
/**
 * safari_start_recording's page recorder (page-recorder.js): what the user does becomes steps, each with a selector
 * ranked as Playwright's recorder ranks them and the safari-mcp call that replays it, and a password is never kept.
 *
 * Run:  node --test test/page-recorder.test.mjs
 */
/* global window, document -- each test sets them to its jsdom page, as the recorder expects */
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

test("an icon-only button is named by its icon and found through stable hooks, not page positions", () => {
  const card = (id) => `<div id="${id}" data-testid="comment-card" class="sim-commentCardPrimary awsui_root_xjuzf_495">
      <div class="sim-commentCardPrimary--author"><span class="awsui_root_xjuzf_sck6h_495 sim-copyToClipboard">
        <button class="awsui_button_vjswe_5stl2_70"><span class="awsui_icon_h11ix_13 awsui_name-copy_h11ix_593"><svg aria-hidden="true"></svg></span></button>
      </span></div></div>`;
  const { document, fire, steps } = page(`<ul><li>${card("eeea8b85-4b90-456f-8f6b-5ae40731626f")}</li><li>${card("1b2c3d4e-0000-1111-2222-333344445555")}</li></ul>`);
  const second = document.querySelectorAll("button")[1];
  fire(second, "click", { button: 0, detail: 1 });
  const [step] = steps();
  assert.equal(step.name, "copy");
  assert.ok(!/awsui_|eeea8b85|1b2c3d4e/.test(step.selector), `selector leans on generated classes or ids: ${step.selector}`);
  assert.match(step.selector, /\[data-testid="comment-card"\]|span\.sim-copyToClipboard/);
  assert.equal(document.querySelector(step.selector), second);
});

test("the badge shows the step count, isn't recorded itself, and goes when recording stops", async () => {
  const dom = new JSDOM(`<!doctype html><body><button>Go</button></body>`, { url: "https://example.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const { pageIndicator } = await import("../page-recorder.js");
  pageIndicator();
  pageRecorder();
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, composed: true, button: 0, detail: 1 }));
  click(document.querySelector("button"));
  const host = document.getElementById("__mcp_indicator");
  assert.ok(host, "the badge is on the page");
  assert.match(host.shadowRoot.textContent, /Recording · 1 step$/);
  click(host);
  assert.equal(window.__mcp_recording.steps.filter((s) => s.type === "click").length, 1);
  pageRecorder("stop");
  assert.equal(document.getElementById("__mcp_indicator"), null);
});

test("recording with the network: one line counting steps and the requests since it started, in place of the capture's", async () => {
  const dom = new JSDOM(`<!doctype html><body><button>Go</button></body>`, { url: "https://example.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const { pageIndicator } = await import("../page-recorder.js");
  pageIndicator();
  window.__mcp_network = [{ time: "2000-01-01T00:00:00.000Z", url: "https://example.test/old" }];
  window.__mcp_setIndicator("network", () => "● Capturing network · 1 requests");
  pageRecorder(undefined, { network: true });
  window.__mcp_network.push({ time: new Date(Date.now() + 5).toISOString(), url: "https://example.test/api" });
  document.querySelector("button").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
  const box = document.getElementById("__mcp_indicator").shadowRoot.textContent;
  assert.equal(box, "● Recording · 1 step · 1 request", "one line, only the request made since it started");
  pageRecorder("stop");
  assert.match(document.getElementById("__mcp_indicator").shadowRoot.textContent, /^● Capturing network · 2 requests$/,
    "the capture, still running, gets its own line back");
  window.__mcp_setIndicator("network", null);
});

test("starting again after a stop begins an empty recording", () => {
  const { document, fire } = page(`<button>Go</button>`);
  fire(document.querySelector("button"), "click", { button: 0, detail: 1 });
  pageRecorder("stop");
  pageRecorder();
  assert.deepEqual(window.__mcp_recording.steps.map((s) => s.type), ["start"]);
});

test("a component that re-fires a click on its inner element records one click, the control's", () => {
  const { document, fire, steps } = page(`<ul role="tablist"><li><a role="tab" href="#c"><span class="label">Communication</span></a></li></ul>`);
  const tab = document.querySelector("[role=tab]");
  const span = document.querySelector("span");
  // The user's click lands on the span; the component then clicks the tab itself.
  fire(span, "click", { button: 0, detail: 1 });
  fire(tab, "click", { button: 0, detail: 1 });
  const clicks = steps().filter((s) => s.type === "click");
  assert.equal(clicks.length, 1);
  assert.deepEqual([clicks[0].role, clicks[0].name], ["tab", "Communication"]);
});

test("two separate clicks on the same element stay two", async () => {
  const { document, fire, steps } = page(`<button>Next</button>`);
  const b = document.querySelector("button");
  fire(b, "click", { button: 0, detail: 1 });
  await new Promise((r) => setTimeout(r, 120));
  fire(b, "click", { button: 0, detail: 1 });
  assert.equal(steps().filter((s) => s.type === "click").length, 2);
});

test("a field whose label another field shares keeps the label in its selector, told apart by its place", () => {
  const { document, fire, steps } = page(`<header class="desktop-header"><input aria-label="Search CMs"></header>
    <div class="mobile-header"><input aria-label="Search CMs"></div>`);
  const field = document.querySelector("header input");
  field.value = "MCM-1"; fire(field, "input");
  const [fill] = steps();
  assert.match(fill.selector, /input\[aria-label="Search CMs"\]/);
  assert.equal(document.querySelector(fill.selector), field);
});
