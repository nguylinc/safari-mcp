// The page scripts of the network and recording tools (rinkagu fork), as functions the extension runs compiled in:
// executeScript with a function runs whatever the page's Content-Security-Policy says, where a script string needs
// eval or an inline script, which a strict CSP (mcm.amazon.dev) refuses. scripts/sync-page-scripts.mjs copies them
// into extension/background.js (a test fails when that copy is stale), so a change here needs that run and an
// extension rebuild; until then, pageScriptSource sends the same code as text through evaluate, and to AppleScript.
//
// Each is self-contained: Safari serialises it into the page, so it can use nothing from this module. A tool runs a
// list of steps, [name, ...args], one after another in the page, and answers with the last one's value.

import { pageIndicator, pageRecorder } from "./page-recorder.js";

// The capture. Each entry is recorded when the request starts and filled in as it completes: the method (from the
// init or, for fetch(new Request(...)), the Request itself), the request's headers and body, and the response's
// status, headers and body (bodies cut at REQ_MAX / RESP_MAX). `headers` is the response's, as upstream had it. A body
// that isn't text (FormData, a Blob) is named, not read. Auth values are redacted, their names kept.
export function networkCapture() {
  if (window.__mcp_network) return;
  window.__mcp_network = [];
  var MAX = 1000, REQ_MAX = 20000, RESP_MAX = 8000;
  var keep = function (e) { window.__mcp_network.push(e); if (window.__mcp_network.length > MAX) window.__mcp_network.shift(); return e; };
  var cut = function (s, n) { return typeof s === "string" && s.length > n ? s.slice(0, n) + "...[" + s.length + " chars]" : s; };
  var bodyText = function (b) {
    if (b == null) return null;
    if (typeof b === "string") return b;
    if (b instanceof URLSearchParams) return b.toString();
    return "[" + Object.prototype.toString.call(b).slice(8, -1) + "]";
  };
  var SECRET = /^(authorization|proxy-authorization|cookie|set-cookie|x-amz-security-token)$|token|csrf|xsrf|secret|session|api-?key|password/i;
  var SECRET_PARAM = /^(code|sig|signature|id_token|access_token)$/i;
  var hideValue = function (k, v) { return SECRET.test(k) ? "<redacted>" : v; };
  var redactHeaders = function (o) { var out = {}; for (var k in o) out[k] = hideValue(k, o[k]); return out; };
  var redactUrl = function (u) {
    try {
      var x = new URL(u, location.href);
      var hit = false;
      x.searchParams.forEach(function (v, k) { if (SECRET.test(k) || SECRET_PARAM.test(k)) hit = true; });
      if (!hit) return String(u);
      var p = new URLSearchParams();
      x.searchParams.forEach(function (v, k) { p.append(k, SECRET.test(k) || SECRET_PARAM.test(k) ? "<redacted>" : v); });
      x.search = p.toString();
      return x.toString();
    } catch (e) {
      return String(u);
    }
  };
  var headersOf = function (h) { try { return redactHeaders(Object.fromEntries(new Headers(h || {}).entries())); } catch (e) { return {}; } };
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var req = typeof Request !== "undefined" && input instanceof Request ? input : null;
    var opts = init || {};
    var start = Date.now();
    var entry = keep({
      url: redactUrl(req ? req.url : String(input)), method: (opts.method || (req && req.method) || "GET").toUpperCase(), type: "fetch",
      requestHeaders: headersOf(opts.headers || (req && req.headers)), requestBody: null, time: new Date().toISOString(),
    });
    if ("body" in opts) entry.requestBody = cut(bodyText(opts.body), REQ_MAX);
    else if (req && entry.method !== "GET" && entry.method !== "HEAD") {
      try { req.clone().text().then(function (t) { entry.requestBody = cut(t, REQ_MAX); }, function () {}); } catch (e) {}
    }
    return origFetch.apply(this, arguments).then(function (resp) {
      entry.status = resp.status; entry.statusText = resp.statusText; entry.duration = Date.now() - start;
      entry.headers = redactHeaders(Object.fromEntries([...resp.headers.entries()]));
      try { resp.clone().text().then(function (t) { entry.responseBody = cut(t, RESP_MAX); }, function () {}); } catch (e) {}
      return resp;
    }).catch(function (err) { entry.error = err.message; entry.duration = Date.now() - start; throw err; });
  };
  var proto = XMLHttpRequest.prototype;
  var origOpen = proto.open, origSend = proto.send, origSetHeader = proto.setRequestHeader;
  proto.open = function (method, url) {
    this.__mcp_entry = { url: redactUrl(String(url)), method: String(method).toUpperCase(), type: "xhr", requestHeaders: {}, requestBody: null };
    return origOpen.apply(this, arguments);
  };
  proto.setRequestHeader = function (name, value) {
    if (this.__mcp_entry) this.__mcp_entry.requestHeaders[name] = hideValue(name, value);
    return origSetHeader.apply(this, arguments);
  };
  proto.send = function (body) {
    var entry = this.__mcp_entry;
    if (entry) {
      var start = Date.now();
      entry.time = new Date().toISOString();
      entry.requestBody = cut(bodyText(body), REQ_MAX);
      keep(entry);
      this.addEventListener("load", function () {
        entry.status = this.status; entry.statusText = this.statusText; entry.duration = Date.now() - start;
        try { entry.responseBody = cut(this.responseText, RESP_MAX); entry.responseSize = this.responseText.length; } catch (e) {}
      });
      this.addEventListener("error", function () { entry.error = "Network error"; entry.duration = Date.now() - start; });
    }
    return origSend.apply(this, arguments);
  };
}

// The capture's line on the badge (pageIndicator), counting live, unless a recording that captures the network
// already counts the requests on its own line.
export function networkBadge() {
  var r = window.__mcp_recording;
  if (r && r.active && r.network) return;
  window.__mcp_setIndicator("network", function () {
    var n = (window.__mcp_network || []).length;
    return "\u25cf Capturing network \u00b7 " + n + " request" + (n === 1 ? "" : "s");
  });
}

export function networkClear() {
  window.__mcp_network = [];
  return "Network capture cleared";
}

export function networkDetails(limit, filter) {
  var list = window.__mcp_network || [];
  if (filter) list = list.filter(function (r) { return String(r.url).includes(filter); });
  return JSON.stringify(list.slice(-limit));
}

// The recording and, when it captures the network, the requests made since it started (bodies cut to bodyMax, so a
// long recording still fits in one answer). automation.js's linkRecording ties them to the steps.
export function recordingRead(limit, clear, bodyMax) {
  var r = window.__mcp_recording;
  if (!r) return JSON.stringify({ recording: false, steps: [] });
  var cut = function (s) { return typeof s === "string" && s.length > bodyMax ? s.slice(0, bodyMax) + "...[" + s.length + " chars]" : s; };
  var net = r.network ? (window.__mcp_network || []).filter(function (e) { return e.time >= r.started; }).map(function (e) {
    var c = {};
    for (var k in e) c[k] = e[k];
    c.requestBody = cut(e.requestBody);
    c.responseBody = cut(e.responseBody);
    return c;
  }) : null;
  var out = JSON.stringify({ recording: r.active, network: !!r.network, started: r.started, total: r.steps.length, steps: r.steps.slice(-limit), requests: net });
  if (clear) r.steps.length = 0;
  return out;
}

export const PAGE_SCRIPTS = { networkCapture, networkBadge, networkClear, networkDetails, recordingRead, pageIndicator, pageRecorder };

// The steps as one script string: the evaluate and AppleScript fallback of an extension that predates page_script.
export function pageScriptSource(steps) {
  const calls = steps.map(([name, ...args]) => {
    if (!PAGE_SCRIPTS[name]) throw new Error(`Unknown page script: ${name}`);
    return `v=(${PAGE_SCRIPTS[name]}).apply(null,${JSON.stringify(args)});`;
  });
  return `(function(){var v;${calls.join("")}return v;})()`;
}

// The block scripts/sync-page-scripts.mjs keeps at the end of extension/background.js.
export const EXTENSION_BLOCK_START = "// ===== page scripts: generated from page-scripts.js by scripts/sync-page-scripts.mjs; edit those, not this =====";
export const EXTENSION_BLOCK_END = "// ===== end of page scripts =====";
export function extensionBlock() {
  const entries = Object.entries(PAGE_SCRIPTS).map(([name, fn]) => `  ${name}: ${fn},`);
  return [
    EXTENSION_BLOCK_START,
    "const _PAGE_SCRIPTS = {",
    ...entries,
    "};",
    "// page_script: each step, [name, ...args], as a compiled function in the tab's MAIN world, which the page's CSP",
    "// can't refuse (evaluate's script strings need eval or an inline script). Answers with the last step's value.",
    "async function _runPageScripts(tabId, steps) {",
    "  if (!Array.isArray(steps) || !steps.length) throw new Error(\"page_script needs steps\");",
    "  let value;",
    "  for (const [name, ...args] of steps) {",
    "    const fn = Object.prototype.hasOwnProperty.call(_PAGE_SCRIPTS, name) ? _PAGE_SCRIPTS[name] : null;",
    "    if (!fn) throw new Error(\"Unknown page script: \" + name);",
    "    value = await execInTab(fn, args, tabId);",
    "  }",
    "  return value;",
    "}",
    EXTENSION_BLOCK_END,
  ].join("\n");
}
