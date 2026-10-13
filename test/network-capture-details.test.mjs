#!/usr/bin/env node
/**
 * safari_start_network_capture records what's needed to replay a request: the method of a
 * fetch(new Request(...)) (it used to read only the init, so every such POST showed as GET), the
 * request's headers and body, and the response's status, headers and body, for fetch and XHR alike.
 *
 * Run:  node --test test/network-capture-details.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const safari = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const script = safari.match(/export const NETWORK_CAPTURE_JS = `([\s\S]*?)`;/)[1];

// A page with a fetch that answers every request, and a minimal XMLHttpRequest.
function page() {
  class FakeXHR {
    constructor() { this.listeners = {}; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 201; this.statusText = "Created"; this.responseText = '{"ok":true}';
      for (const fn of this.listeners.load || []) fn.call(this);
    }
  }
  const window = {
    fetch: async (input) => new Response(`echo ${input instanceof Request ? input.url : input}`, { status: 200, headers: { "x-test": "1" } }),
  };
  const context = vm.createContext({ window, XMLHttpRequest: FakeXHR, Request, Response, Headers, URL, URLSearchParams, Date, Object, String, location: { href: "https://example.test/" } });
  vm.runInContext(script, context);
  return { window, context };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("fetch(Request): the Request's method, headers and body, and the response's body", async () => {
  const { window } = page();
  const body = JSON.stringify([{ operationName: "createComment", variables: { message: "hi" } }]);
  await window.fetch(new Request("https://example.test/graphql", { method: "POST", headers: { "content-type": "application/json" }, body }));
  await settle();
  const [entry] = window.__mcp_network;
  assert.equal(entry.method, "POST");
  assert.equal(entry.url, "https://example.test/graphql");
  assert.equal(entry.requestHeaders["content-type"], "application/json");
  assert.equal(entry.requestBody, body);
  assert.equal(entry.status, 200);
  assert.equal(entry.headers["x-test"], "1");
  assert.equal(entry.responseBody, "echo https://example.test/graphql");
});

test("fetch(url, init): the init's method and body; a body that isn't text is named, not read", async () => {
  const { window } = page();
  await window.fetch("https://example.test/a", { method: "put", body: new URLSearchParams({ q: "1" }) });
  await window.fetch("https://example.test/b", { method: "POST", body: new Blob(["x"]) });
  await settle();
  assert.equal(window.__mcp_network[0].method, "PUT");
  assert.equal(window.__mcp_network[0].requestBody, "q=1");
  assert.equal(window.__mcp_network[1].requestBody, "[Blob]");
});

test("XHR: method, set headers, body and response", () => {
  const { window, context } = page();
  const xhr = new context.XMLHttpRequest();
  xhr.open("post", "https://example.test/x");
  xhr.setRequestHeader("X-Request-Id", "t");
  xhr.send("a=1");
  const [entry] = window.__mcp_network;
  assert.deepEqual([entry.method, entry.requestHeaders["X-Request-Id"], entry.requestBody, entry.status, entry.responseBody], ["POST", "t", "a=1", 201, '{"ok":true}']);
});

test("starting twice wraps fetch once", async () => {
  const { window, context } = page();
  vm.runInContext(script, context);
  await window.fetch("https://example.test/once");
  assert.equal(window.__mcp_network.length, 1);
});

test("auth values are never kept: header values and token-carrying URL parameters are redacted, their names kept", async () => {
  const { window, context } = page();
  await window.fetch("https://example.test/sso/login?id_token=eyJabc&next=%2Fhome", {
    method: "POST", headers: { Authorization: "Bearer secret", "X-CSRF-Token": "t1", "content-type": "application/json" }, body: "{}",
  });
  const xhr = new context.XMLHttpRequest();
  xhr.open("GET", "https://example.test/api?session=s1&page=2");
  xhr.setRequestHeader("Cookie", "a=b");
  xhr.send(null);
  await settle();
  const [f, x] = window.__mcp_network;
  assert.equal(f.requestHeaders.authorization, "<redacted>");
  assert.equal(f.requestHeaders["x-csrf-token"], "<redacted>");
  assert.equal(f.requestHeaders["content-type"], "application/json");
  assert.match(f.url, /id_token=%3Credacted%3E/);
  assert.match(f.url, /next=%2Fhome/);
  assert.equal(x.requestHeaders.Cookie, "<redacted>");
  assert.match(x.url, /session=%3Credacted%3E&page=2/);
  // The request side (a response body is kept as it is, and this fake server echoes the URL back)
  const sent = window.__mcp_network.map((e) => ({ url: e.url, headers: e.requestHeaders, body: e.requestBody }));
  assert.ok(!JSON.stringify(sent).match(/secret|eyJabc|\bt1\b|a=b|s1/));
});
