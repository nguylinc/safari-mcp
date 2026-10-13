#!/usr/bin/env node
/**
 * safari_get_recording's automation export (automation.js): a recording becomes a saved automation a runner replays,
 * with what was typed as {{params}}, an in-app navigation folded into the step that caused it, and no password.
 *
 * Run:  node --test test/automation.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { recordingToAutomation } from "../automation.js";

const url = "https://t.example.test/P1/communication";
const recording = {
  steps: [
    { type: "start", t: 0, url, tool: null },
    { type: "click", t: 100, url, role: "tab", name: "Overview", selector: '[data-testid="overview"]', tool: { name: "safari_click", args: { text: "Overview" } } },
    { type: "navigate", t: 300, url: "https://t.example.test/P1/overview", tool: { name: "safari_navigate", args: { url: "https://t.example.test/P1/overview" } } },
    { type: "fill", t: 900, url, role: "textbox", name: "Add comment", selector: "#comment", value: "Hello", tool: { name: "safari_fill", args: { selector: "#comment", value: "Hello" } } },
    { type: "fill", t: 950, url, role: "textbox", name: "", selector: "#pw", value: null, redacted: true, tool: { name: "safari_fill", args: { selector: "#pw", value: "<password>" } } },
    { type: "submit", t: 999, url, selector: "form", tool: null },
    { type: "click", t: 1000, url, role: "button", name: "Post", selector: '[data-testid="post"]', tool: { name: "safari_click", args: { selector: '[data-testid="post"]' } } },
  ],
};

test("steps, params and the start URL", () => {
  const a = recordingToAutomation(recording, { name: "comment", server: "safari-amazon" });
  assert.deepEqual([a.name, a.server, a.start], ["comment", "safari-amazon", url]);
  assert.deepEqual(a.steps.map((s) => s.tool), ["safari_click", "safari_fill", "safari_fill", "safari_click"]);
  assert.equal(a.steps[0].expectUrl, "https://t.example.test/P1/overview", "the navigation the click caused is its expectUrl");
  assert.deepEqual(a.steps[1].args, { selector: "#comment", value: "{{add_comment}}" });
  assert.deepEqual(a.params.add_comment, { description: "Add comment", default: "Hello" });
});

test("a password becomes a param with no default, and nothing typed into it is kept", () => {
  const a = recordingToAutomation(recording);
  const pw = Object.entries(a.params).find(([, p]) => /password/.test(p.description));
  assert.ok(pw, "the password field is a param");
  assert.equal(pw[1].default, undefined);
  assert.equal(a.steps[2].args.value, `{{${pw[0]}}}`);
  assert.ok(!JSON.stringify(a).includes("<password>"));
});
