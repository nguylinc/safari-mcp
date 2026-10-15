// The page scripts of the network, recording and read-only inspection tools (rinkagu fork), as functions the extension
// runs compiled in: executeScript with a function runs whatever the page's Content-Security-Policy says, where a script
// string needs eval or an inline script, which a strict CSP (mcm.amazon.dev) refuses. scripts/sync-page-scripts.mjs copies them
// into extension/background.js (a test fails when that copy is stale), so a change here needs that run and an
// extension rebuild; until then, pageScriptSource sends the same code as text through evaluate, and to AppleScript.
//
// Each is self-contained: Safari serialises it into the page, so it can use nothing from this module. A tool runs a
// list of steps, [name, ...args], one after another in the page, and answers with the last one's value.

import { pageIndicator, pageRecorder } from "./page-recorder.js";
import { checkPWA, inspectViewport } from "./injected-validators.js";

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

// The read-only inspection tools (safari_get_computed_style and the extract, IndexedDB, performance and audit tools).

export function computedStyle(selector, properties) {
  var el = document.querySelector(selector);
  if (!el) return JSON.stringify({ error: "Element not found" });
  var styles = window.getComputedStyle(el);
  var result = {};
  var props = [].slice.call(styles);
  if (properties) props = props.filter(function (p) { return properties.indexOf(p) !== -1; });
  props.forEach(function (p) { result[p] = styles.getPropertyValue(p); });
  return JSON.stringify(result);
}

export function performanceMetrics() {
  var nav = performance.getEntriesByType("navigation")[0] || {};
  var paint = performance.getEntriesByType("paint");
  var fcp = paint.find(function (p) { return p.name === "first-contentful-paint"; });
  var lcp = null;
  try {
    var lcps = performance.getEntriesByType("largest-contentful-paint");
    if (lcps.length) lcp = lcps[lcps.length - 1];
  } catch (e) {}
  var cls = 0;
  try {
    performance.getEntriesByType("layout-shift").forEach(function (e) { if (!e.hadRecentInput) cls += e.value; });
  } catch (e) {}
  var resources = performance.getEntriesByType("resource");
  var totalTransfer = resources.reduce(function (sum, r) { return sum + (r.transferSize || 0); }, 0);
  return JSON.stringify({
    navigation: {
      dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
      tcp: Math.round(nav.connectEnd - nav.connectStart),
      ttfb: Math.round(nav.responseStart - nav.requestStart),
      download: Math.round(nav.responseEnd - nav.responseStart),
      domInteractive: Math.round(nav.domInteractive),
      domComplete: Math.round(nav.domComplete),
      loadEvent: Math.round(nav.loadEventEnd),
    },
    webVitals: {
      fcp: fcp ? Math.round(fcp.startTime) : null,
      lcp: lcp ? Math.round(lcp.startTime) : null,
      cls: Math.round(cls * 1000) / 1000,
    },
    resources: {
      total: resources.length,
      totalTransferKB: Math.round(totalTransfer / 1024),
      byType: resources.reduce(function (acc, r) {
        var type = r.initiatorType || "other";
        if (!acc[type]) acc[type] = { count: 0, sizeKB: 0 };
        acc[type].count++;
        acc[type].sizeKB += Math.round((r.transferSize || 0) / 1024);
        return acc;
      }, {}),
    },
    memory: performance.memory ? {
      usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
      totalMB: Math.round(performance.memory.totalJSHeapSize / 1048576),
      limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576),
    } : null,
  });
}

export function extractTables(selector, limit) {
  var tables = [].slice.call(document.querySelectorAll(selector || "table")).slice(0, limit);
  var texts = function (root, sel) { return [].slice.call(root.querySelectorAll(sel)); };
  return JSON.stringify(tables.map(function (table, ti) {
    var headers = texts(table, "thead th, thead td, tr:first-child th").map(function (th) { return th.textContent.trim(); });
    var rows = texts(table, "tbody tr, tr").slice(headers.length ? 0 : 1).map(function (tr) {
      return texts(tr, "td, th").map(function (td) { return td.textContent.trim().substring(0, 200); });
    });
    return { index: ti, headers: headers, rows: rows.slice(0, 100), rowCount: rows.length };
  }));
}

export function extractMeta() {
  var all = function (sel) { return [].slice.call(document.querySelectorAll(sel)); };
  var meta = {};
  meta.title = document.title;
  meta.description = (document.querySelector('meta[name="description"]') || {}).content || "";
  meta.canonical = (document.querySelector('link[rel="canonical"]') || {}).href || "";
  meta.robots = (document.querySelector('meta[name="robots"]') || {}).content || "";
  meta.viewport = (document.querySelector('meta[name="viewport"]') || {}).content || "";
  var charset = document.querySelector("meta[charset]");
  meta.charset = (charset && charset.getAttribute("charset")) || document.characterSet;
  meta.language = document.documentElement.lang || "";
  meta.og = {};
  all('meta[property^="og:"]').forEach(function (m) { meta.og[m.getAttribute("property").replace("og:", "")] = m.content; });
  meta.twitter = {};
  all('meta[name^="twitter:"]').forEach(function (m) { meta.twitter[m.getAttribute("name").replace("twitter:", "")] = m.content; });
  meta.jsonLd = all('script[type="application/ld+json"]').map(function (s) {
    try { return JSON.parse(s.textContent); } catch (e) { return null; }
  }).filter(Boolean);
  meta.alternateLanguages = all('link[rel="alternate"][hreflang]').map(function (l) { return { lang: l.hreflang, href: l.href }; });
  meta.feeds = all('link[type="application/rss+xml"], link[type="application/atom+xml"]').map(function (l) {
    return { title: l.title, href: l.href, type: l.type };
  });
  return JSON.stringify(meta);
}

export function extractImages(limit) {
  return JSON.stringify([].slice.call(document.querySelectorAll("img")).slice(0, limit).map(function (img) {
    var r = img.getBoundingClientRect();
    return {
      src: img.src, alt: img.alt || "(missing)", width: img.naturalWidth, height: img.naturalHeight,
      displayWidth: Math.round(r.width), displayHeight: Math.round(r.height),
      loading: img.loading || "eager", srcset: img.srcset || "",
      inViewport: r.top < window.innerHeight && r.bottom > 0,
      decoded: img.complete,
    };
  }));
}

export function extractLinks(limit, filter) {
  var links = [].slice.call(document.querySelectorAll("a[href]"));
  if (filter) links = links.filter(function (a) { return a.href.includes(filter) || a.textContent.includes(filter); });
  return JSON.stringify(links.slice(0, limit).map(function (a) {
    return {
      href: a.href, text: a.textContent.trim().substring(0, 100),
      rel: a.rel || "", target: a.target || "",
      isExternal: a.hostname !== location.hostname,
      isNofollow: a.rel.includes("nofollow"),
    };
  }));
}

export async function listIndexedDBs() {
  try {
    var dbs = await indexedDB.databases();
    return JSON.stringify(dbs.map(function (db) { return { name: db.name, version: db.version }; }));
  } catch (e) {
    return JSON.stringify({ error: "indexedDB.databases() not supported, try getIndexedDB with a known db name" });
  }
}

export function readIndexedDB(dbName, storeName, limit) {
  return new Promise(function (resolve) {
    var request = indexedDB.open(dbName);
    request.onerror = function () { resolve(JSON.stringify({ error: "Cannot open database: " + dbName })); };
    request.onsuccess = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(storeName)) {
        resolve(JSON.stringify({ error: "Store not found: " + storeName, stores: [].slice.call(db.objectStoreNames) }));
        db.close();
        return;
      }
      var results = [];
      var cursor = db.transaction(storeName, "readonly").objectStore(storeName).openCursor();
      cursor.onsuccess = function (ev) {
        var c = ev.target.result;
        if (c && results.length < limit) { results.push({ key: c.key, value: c.value }); c.continue(); }
        else { resolve(JSON.stringify({ database: dbName, store: storeName, count: results.length, records: results })); db.close(); }
      };
      cursor.onerror = function () { resolve(JSON.stringify({ error: "Cursor error" })); db.close(); };
    };
  });
}

export function analyzePage() {
  var all = function (sel) { return [].slice.call(document.querySelectorAll(sel)); };
  var result = {};
  result.title = document.title;
  result.url = location.href;
  result.meta = {};
  result.meta.description = (document.querySelector('meta[name="description"]') || {}).content || "";
  result.meta.canonical = (document.querySelector('link[rel="canonical"]') || {}).href || "";
  result.meta.robots = (document.querySelector('meta[name="robots"]') || {}).content || "";
  result.meta.og = {};
  all('meta[property^="og:"]').forEach(function (m) { result.meta.og[m.getAttribute("property").replace("og:", "")] = m.content; });
  result.headings = {};
  for (var i = 1; i <= 3; i++) result.headings["h" + i] = all("h" + i).map(function (h) { return h.textContent.trim().substring(0, 100); });
  result.links = { internal: 0, external: 0, nofollow: 0 };
  all("a[href]").forEach(function (a) {
    if (a.hostname === location.hostname) result.links.internal++;
    else result.links.external++;
    if (a.rel && a.rel.includes("nofollow")) result.links.nofollow++;
  });
  result.images = { total: all("img").length, withoutAlt: all('img:not([alt]),img[alt=""]').length };
  result.forms = all("form").length;
  result.text = document.body.innerText.substring(0, 5000);
  return JSON.stringify(result);
}

export const PAGE_SCRIPTS = {
  networkCapture, networkBadge, networkClear, networkDetails, recordingRead, pageIndicator, pageRecorder,
  computedStyle, performanceMetrics, extractTables, extractMeta, extractImages, extractLinks, listIndexedDBs, readIndexedDB,
  inspectViewport, checkPWA, analyzePage,
};

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
