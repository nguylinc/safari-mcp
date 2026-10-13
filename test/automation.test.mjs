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

test("the draft flags what an agent should check before saving it", () => {
  const steps = [
    { type: "start", t: 0, url: "https://t.example.test/P534955152/communication", tool: null },
    { type: "scroll", t: 50, url: "https://t.example.test/P534955152/communication", tool: { name: "safari_scroll_to", args: { x: 0, y: 200 } } },
    { type: "click", t: 100, role: "tab", name: "Overview", tool: { name: "safari_click", args: { text: "Overview" } } },
    { type: "navigate", t: 200, url: "https://t.example.test/P534955152/overview", tool: { name: "safari_navigate", args: {} } },
    { type: "click", t: 3000, role: "tab", name: "Communication", tool: { name: "safari_click", args: { text: "Communication" } } },
    { type: "navigate", t: 3100, url: "https://t.example.test/P534955152/communication", tool: { name: "safari_navigate", args: {} } },
    { type: "click", t: 4000, role: null, name: "nguylinc 12:23", tool: { name: "safari_click", args: { selector: "ul > li:nth-of-type(2) > div" } } },
    { type: "click", t: 5000, role: "button", name: "Post", tool: { name: "safari_click", args: { selector: '[data-testid="post"]' } } },
  ];
  const a = recordingToAutomation({ steps });
  const [scroll, overview, back, header, post] = a.steps;
  assert.match(scroll.review.join(" "), /a scroll/);
  assert.equal(overview.review, undefined);
  assert.match(back.review.join(" "), /returns to a page visited earlier/);
  assert.match(header.review.join(" "), /position-based selector/);
  assert.match(header.review.join(" "), /isn't a control/);
  assert.equal(post.review, undefined);
  assert.ok(a.review.some((r) => r.includes("P534955152")), "the id in the start URL is pointed out");
  assert.ok(a.review.some((r) => /3 of 5 steps are flagged/.test(r)));
});

test("requests: each tied to the step that set it off, polling folded apart, and a write pointed out in the review", async () => {
  const { linkRecording } = await import("../automation.js");
  const started = "2026-10-13T20:00:00.000Z";
  const at = (ms) => new Date(Date.parse(started) + ms).toISOString();
  const gql = (op, kind) => JSON.stringify([{ operationName: op, query: `${kind} ${op} { x }` }]);
  const recording = {
    network: true, started,
    steps: [
      { type: "start", t: 0, url: "https://t.example.test/P1/communication", tool: null },
      { type: "click", t: 1000, role: "button", name: "Post", selector: '[data-testid="post"]', tool: { name: "safari_click", args: { selector: '[data-testid="post"]' } } },
    ],
    requests: [
      ...[0, 5000, 10000, 15000].map((ms) => ({ time: at(ms + 1100), method: "GET", url: `https://t.example.test/status?ts=${ms}`, status: 200, responseBody: "ok" })),
      { time: at(1200), method: "POST", url: "https://gql.example.test/graphql", status: 200, requestBody: gql("createComment", "mutation") },
      { time: at(1500), method: "POST", url: "https://gql.example.test/graphql", status: 200, requestBody: gql("threadComments", "query") },
      { time: at(9000), method: "GET", url: "https://t.example.test/lazy", status: 200 },
    ],
  };
  const linked = linkRecording(recording);
  const post = linked.steps[1];
  assert.deepEqual(post.requests.map((r) => JSON.parse(r.requestBody)[0].operationName), ["createComment", "threadComments"],
    "the click's own requests, not the poll that landed just after it");
  assert.deepEqual(linked.background.polling.map((p) => [p.request, p.count, p.everyMs]), [["GET https://t.example.test/status", 4, 5000]]);
  assert.deepEqual(linked.background.requests.map((r) => r.url), ["https://t.example.test/lazy"]);
  const draft = recordingToAutomation(recording);
  assert.match(draft.steps[0].review.join(" "), /called `createComment` on gql\.example\.test/);
  assert.ok(!draft.steps[0].review.join(" ").includes("threadComments"), "a read query isn't a write");
});
