// The interaction recorder safari_start_recording installs in a page (rinkagu fork). It watches what the user does -
// clicks, typing, keys, selects, submits, scrolls, in-app navigation - in the capture phase, before the page's own
// handlers, and keeps each action as a step in window.__mcp_recording.steps: what was done, to which element (a
// selector chosen the way Playwright's recorder ranks them: test id, then id, then role and accessible name, then
// label or placeholder, then text, then a CSS path), and the safari-mcp call that does it again.
//
// It runs as page JavaScript (safari.js sends `(${pageRecorder})()`), so it uses nothing from Node. Like the network
// capture, it lives in the page: a full load ends it, in-app navigation doesn't. A password field's value is never
// kept, and nothing is recorded until the recorder is started, or after it's stopped.

// `network`: the page's requests are being captured with it (safari.js installs the network capture first), so the
// badge counts them on the recording's line, in place of the capture's own.
export function pageRecorder(command, options) {
  const w = window;
  const doc = document;
  const network = !!(options && options.network);
  if (command === "stop") {
    if (!w.__mcp_recording) return "not recording";
    w.__mcp_recording.stop();
    return `stopped: ${w.__mcp_recording.steps.length} steps kept`;
  }
  if (w.__mcp_recording && w.__mcp_recording.active) return `already recording (${w.__mcp_recording.steps.length} steps)`;

  const MAX_STEPS = 2000;
  const started = Date.now();
  // A new recording starts empty: an earlier, stopped one's steps would read as this one's.
  const steps = [];
  const cleanups = [];
  const startedIso = new Date(started).toISOString();
  const requestCount = () => (w.__mcp_network || []).filter((r) => r.time >= startedIso).length;
  const setLine = (key, text) => { if (w.__mcp_setIndicator) w.__mcp_setIndicator(key, text); };
  const rec = { active: true, network, steps, started: startedIso, stop() {
    rec.active = false;
    for (const undo of cleanups.splice(0)) undo();
    setLine("recording", null);
    // The capture keeps going after the recording stops (it has no stop): its own line says so again.
    if (network && w.__mcp_network) setLine("network", () => `● Capturing network · ${(w.__mcp_network || []).length} requests`);
  } };
  w.__mcp_recording = rec;
  if (network) setLine("network", null);
  const recordingLine = () => {
    const n = steps.filter((s) => s.type !== "start").length;
    return `● Recording · ${n} step${n === 1 ? "" : "s"}${network ? ` · ${requestCount()} request${requestCount() === 1 ? "" : "s"}` : ""}`;
  };
  setLine("recording", recordingLine);

  const css = (s) => (w.CSS && w.CSS.escape ? w.CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
  const quoted = (s) => `"${String(s).replace(/["\\]/g, "\\$&")}"`;
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const unique = (selector, el) => {
    try {
      const all = doc.querySelectorAll(selector);
      return all.length === 1 && all[0] === el;
    } catch {
      return false;
    }
  };

  // The element an action was meant for: the clickable one around the click target.
  const CLICKABLE = "a[href],button,input,select,textarea,label,summary,option,[role=button],[role=link],[role=tab]," +
    "[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=switch],[role=combobox],[onclick],[tabindex]";
  const targetOf = (event) => {
    const path = event.composedPath ? event.composedPath() : [];
    const first = path.find((n) => n && n.nodeType === 1) || event.target;
    return (first && first.closest && first.closest(CLICKABLE)) || first;
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button" || (tag === "input" && ["button", "submit", "reset", "image"].includes(type))) return "button";
    if (tag === "input" && type === "checkbox") return "checkbox";
    if (tag === "input" && type === "radio") return "radio";
    if (tag === "input" || tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "summary") return "button";
    if (tag === "option") return "option";
    return null;
  };
  const labelText = (el) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by.split(/\s+/).map((id) => doc.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(" ");
      if (norm(text)) return norm(text);
    }
    if (el.id) {
      const label = doc.querySelector(`label[for="${css(el.id)}"]`);
      if (label && norm(label.textContent)) return norm(label.textContent);
    }
    const wrapping = el.closest && el.closest("label");
    return wrapping && wrapping !== el ? norm(wrapping.textContent) : "";
  };
  const nameOf = (el) => {
    const aria = norm(el.getAttribute("aria-label"));
    if (aria) return aria;
    const label = labelText(el);
    if (label) return label;
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea" && tag !== "select") {
      const text = norm(el.innerText !== undefined ? el.innerText : el.textContent);
      if (text && text.length <= 80) return text;
    }
    // An input's value is its name only for a button (`<input type=submit value="Save">`): never for a field, so
    // what was typed (a password above all) can't leak into the step's name.
    const buttonValue = tag === "input" && ["button", "submit", "reset"].includes((el.getAttribute("type") || "").toLowerCase()) ? el.value : "";
    return norm(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || buttonValue || "") ||
      iconName(el);
  };

  // A class a person wrote (`sim-copyToClipboard`, `save-button`), not one a build generated (`awsui_button_vjswe_5stl2_70`,
  // `css-1x2y3z`): letters, digits and dashes, no underscore, no long digit run, no short hash segment.
  const stableClass = (node) => [...(node.classList || [])].find((c) =>
    /^[A-Za-z][A-Za-z0-9-]{2,39}$/.test(c) && !/\d{3,}/.test(c) && !/^(css|sc|jsx|emotion|svelte)-/.test(c) && !/-[a-z0-9]{5,}$/.test(c));
  const words = (s) => s.replace(/^[a-z]{1,4}-(?=[a-z])/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").toLowerCase().trim();

  // An icon-only control's name: its icon's (a design system's `name-copy` / `icon-close` class, an svg <title>, an
  // image's alt, a labelled child), else a readable class on it or a close ancestor (`sim-copyToClipboard`).
  const iconName = (el) => {
    for (const node of [el, ...el.querySelectorAll("*")].slice(0, 30)) {
      const cls = typeof node.className === "string" ? node.className : (node.getAttribute && node.getAttribute("class")) || "";
      const m = cls.match(/(?:^|[\s_-])name-([a-z][a-z0-9-]*?)(?:_|\s|$)/) || cls.match(/(?:^|\s)icon-([a-z][a-z0-9-]+)(?:\s|$)/);
      if (m) return words(m[1]);
      if (node !== el) {
        const label = node.tagName === "title" || node.tagName === "TITLE" ? node.textContent : node.getAttribute("aria-label") || node.getAttribute("alt") || node.getAttribute("title");
        if (norm(label)) return norm(label);
      }
    }
    for (let node = el, i = 0; node && i < 4; node = node.parentElement, i++) {
      const c = stableClass(node);
      if (c) return words(c);
    }
    return "";
  };

  // A selector for one step of the path: a test id, a stable id, a readable class, else just the tag.
  const TEST_IDS = ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"];
  const hookOf = (node) => {
    for (const attr of TEST_IDS) {
      const v = node.getAttribute(attr);
      if (v) return `[${attr}=${quoted(v)}]`;
    }
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && !/\d{3,}/.test(node.id)) return `#${css(node.id)}`;
    const c = stableClass(node);
    return c ? `${node.tagName.toLowerCase()}.${css(c)}` : null;
  };
  // Which of its same-tag siblings a node is, when its hook alone doesn't tell them apart.
  const nth = (node, hook) => {
    const parent = node.parentElement;
    if (!parent) return hook;
    const matching = [...parent.children].filter((c) => { try { return c.matches(hook); } catch { return false; } });
    if (matching.length < 2) return hook;
    const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
    return `${hook}:nth-of-type(${sameTag.indexOf(node) + 1})`;
  };

  // A CSS path built from the stable hooks above the element (descendant steps, skipping the levels that have none),
  // short as it can be while still matching only the element; the strict child path of tags and positions only
  // when the hooks never get there.
  const cssPath = (el) => {
    const tag = el.tagName.toLowerCase();
    const own = hookOf(el) || tag;
    const parts = [nth(el, own)];
    if (unique(parts[0], el)) return parts[0];
    let top = el;
    for (let node = el.parentElement; node && node !== doc.documentElement; node = node.parentElement) {
      const hook = hookOf(node);
      if (!hook) continue;
      parts.unshift(nth(node, hook));
      top = node;
      const candidate = parts.join(" ");
      if (unique(candidate, el)) return candidate;
    }
    // Still several (the same hooks in each item of a list): say which item, by the position of the nearest
    // repeated ancestor above the hooks (`li:nth-of-type(2) [data-testid="comment-card"] … button`).
    if (top !== el) {
      for (let node = top.parentElement; node && node !== doc.documentElement; node = node.parentElement) {
        const positioned = nth(node, node.tagName.toLowerCase());
        if (positioned === node.tagName.toLowerCase()) continue;
        const candidate = `${positioned} ${parts.join(" ")}`;
        if (unique(candidate, el)) return candidate;
        parts.unshift(positioned);
      }
    }
    const strict = [];
    for (let node = el; node && node.nodeType === 1 && node !== doc.documentElement; node = node.parentElement) {
      strict.unshift(nth(node, node.tagName.toLowerCase()));
      if (unique(strict.join(" > "), el)) break;
    }
    return strict.join(" > ");
  };

  // The best selector for an element (a CSS one, so every safari-mcp tool takes it) and its role and name.
  const describe = (el) => {
    const role = roleOf(el);
    const name = nameOf(el);
    let selector = null;
    for (const attr of ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"]) {
      const v = el.getAttribute(attr);
      if (v && unique(`[${attr}=${quoted(v)}]`, el)) { selector = `[${attr}=${quoted(v)}]`; break; }
    }
    if (!selector && el.id && /^[A-Za-z][\w-]*$/.test(el.id) && !/\d{3,}/.test(el.id) && unique(`#${css(el.id)}`, el)) selector = `#${css(el.id)}`;
    const tag = el.tagName.toLowerCase();
    for (const attr of ["aria-label", "name", "placeholder", "title"]) {
      if (selector) break;
      const v = el.getAttribute(attr);
      if (v && unique(`${tag}[${attr}=${quoted(v)}]`, el)) selector = `${tag}[${attr}=${quoted(v)}]`;
    }
    if (!selector) selector = cssPath(el);
    return { selector, role, name };
  };

  // safari_click's `text` matches a visible button, link or tab whose whole text is exactly it: use it when this
  // element is the only one like that.
  const clickByText = (el, name) => {
    if (!name || !["button", "link", "tab", "menuitem", "option"].includes(roleOf(el) || "")) return false;
    const same = [...doc.querySelectorAll("button,a,[role=button],[role=link],[role=tab],[role=menuitem],[role=option]")]
      .filter((c) => norm(c.innerText !== undefined ? c.innerText : c.textContent) === name);
    return same.length === 1 && same[0] === el && norm(el.innerText !== undefined ? el.innerText : el.textContent) === name;
  };

  const push = (step) => {
    if (!rec.active) return null;
    step.t = Date.now() - started;
    step.url = w.location.href;
    steps.push(step);
    if (steps.length > MAX_STEPS) steps.shift();
    setLine("recording", recordingLine); // redrawn now, not at the next second
    return step;
  };
  // The indicator badge isn't part of the page: what's done to it isn't recorded.
  const onBadge = (event) => (event.composedPath ? event.composedPath() : []).some((n) => n && n.id === "__mcp_indicator");
  const listen = (target, type, fn) => {
    const wrapped = (event) => { try { if (!onBadge(event)) fn(event); } catch {} };
    target.addEventListener(type, wrapped, true);
    cleanups.push(() => target.removeEventListener(type, wrapped, true));
  };
  const isPassword = (el) => el.tagName === "INPUT" && (el.type || "").toLowerCase() === "password";
  const isTextField = (el) => {
    const tag = el.tagName;
    const type = (el.type || "").toLowerCase();
    return tag === "TEXTAREA" || el.isContentEditable ||
      (tag === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color"].includes(type));
  };

  push({ type: "start", tool: null });

  listen(doc, "click", (event) => {
    if (event.button !== 0) return;
    const el = targetOf(event);
    if (!el || !el.tagName) return;
    if (isTextField(el) || el.tagName === "SELECT" || el.tagName === "OPTION") return; // focusing a field; its value is the step
    if (el.tagName === "INPUT" && ["checkbox", "radio"].includes((el.type || "").toLowerCase())) return; // `change` records it
    const d = describe(el);
    const last = steps[steps.length - 1];
    if (event.detail === 2 && last && last.type === "click" && last.selector === d.selector) {
      last.type = "dblclick";
      last.tool = { name: "safari_double_click", args: { selector: d.selector } };
      return;
    }
    const tool = clickByText(el, d.name) ? { name: "safari_click", args: { text: d.name } } : { name: "safari_click", args: { selector: d.selector } };
    push({ type: "click", ...d, tool });
  });
  listen(doc, "contextmenu", (event) => {
    const el = targetOf(event);
    if (!el || !el.tagName) return;
    const d = describe(el);
    push({ type: "right_click", ...d, tool: { name: "safari_right_click", args: { selector: d.selector } } });
  });
  listen(doc, "input", (event) => {
    const el = event.composedPath ? event.composedPath()[0] : event.target;
    if (!el || !el.tagName || !isTextField(el)) return;
    const d = describe(el);
    const value = isPassword(el) ? null : el.isContentEditable ? el.innerText : el.value;
    const last = steps[steps.length - 1];
    if (last && last.type === "fill" && last.selector === d.selector) {
      last.value = value;
      last.t = Date.now() - started;
      if (last.tool) last.tool.args.value = value === null ? "<password>" : value;
      return;
    }
    push({ type: "fill", ...d, value, redacted: value === null,
      tool: { name: "safari_fill", args: { selector: d.selector, value: value === null ? "<password>" : value } } });
  });
  listen(doc, "change", (event) => {
    const el = event.target;
    if (!el || !el.tagName) return;
    const d = describe(el);
    if (el.tagName === "SELECT") {
      const option = el.selectedOptions && el.selectedOptions[0];
      push({ type: "select", ...d, value: el.value, optionText: option ? norm(option.textContent) : null,
        tool: { name: "safari_select_option", args: { selector: d.selector, value: el.value } } });
    } else if (el.tagName === "INPUT" && ["checkbox", "radio"].includes((el.type || "").toLowerCase())) {
      push({ type: el.checked ? "check" : "uncheck", ...d, tool: { name: "safari_click", args: { selector: d.selector } } });
    }
  });
  const SPECIAL = /^(Enter|Escape|Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End|Delete|F\d{1,2})$/;
  listen(doc, "keydown", (event) => {
    if (event.isComposing || event.repeat) return;
    const modifiers = ["Meta", "Control", "Alt"].filter((m) => event.getModifierState && event.getModifierState(m));
    if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
    if (!SPECIAL.test(event.key) && !modifiers.length) return; // plain typing is the fill step
    const el = event.target && event.target.tagName ? event.target : null;
    const d = el && el !== doc.body ? describe(el) : { selector: null, role: null, name: "" };
    if (event.shiftKey) modifiers.push("Shift");
    // safari_press_key takes the DOM key name and cmd / ctrl / alt / shift.
    const args = { key: event.key };
    if (modifiers.length) args.modifiers = modifiers.map((m) => ({ Meta: "cmd", Control: "ctrl", Alt: "alt", Shift: "shift" })[m]);
    push({ type: "press", key: event.key, modifiers, ...d, tool: { name: "safari_press_key", args } });
  });
  listen(doc, "submit", (event) => {
    const el = event.target;
    if (!el || !el.tagName) return;
    push({ type: "submit", ...describe(el), tool: null });
  });

  // Scrolls: one step per pause (500 ms), the window's or an element's.
  const scrollTimers = new Map();
  listen(doc, "scroll", (event) => {
    const el = event.target === doc || event.target === doc.documentElement ? null : event.target;
    const key = el || w;
    clearTimeout(scrollTimers.get(key));
    scrollTimers.set(key, setTimeout(() => {
      scrollTimers.delete(key);
      if (!el) {
        push({ type: "scroll", selector: null, x: Math.round(w.scrollX), y: Math.round(w.scrollY),
          tool: { name: "safari_scroll_to", args: { x: Math.round(w.scrollX), y: Math.round(w.scrollY) } } });
      } else if (el.tagName) {
        const d = describe(el);
        push({ type: "scroll", ...d, x: Math.round(el.scrollLeft), y: Math.round(el.scrollTop),
          tool: { name: "safari_evaluate", args: { script: `document.querySelector(${JSON.stringify(d.selector)}).scrollTo(${Math.round(el.scrollLeft)}, ${Math.round(el.scrollTop)})` } } });
      }
    }, 500));
  });
  cleanups.push(() => { for (const t of scrollTimers.values()) clearTimeout(t); scrollTimers.clear(); });

  // In-app navigation: pushState / replaceState, back and forward, hash changes.
  const navigated = (how) => {
    const last = steps[steps.length - 1];
    if (last && last.type === "navigate" && last.url === w.location.href) return;
    push({ type: "navigate", how, tool: { name: "safari_navigate", args: { url: w.location.href } } });
  };
  for (const method of ["pushState", "replaceState"]) {
    const original = w.history[method];
    w.history[method] = function (...args) {
      const result = original.apply(this, args);
      navigated(method);
      return result;
    };
    cleanups.push(() => { w.history[method] = original; });
  }
  listen(w, "popstate", () => navigated("popstate"));
  listen(w, "hashchange", () => navigated("hashchange"));

  return "recording clicks, typing, keys, selects, submits, scrolls and in-app navigation";
}

// The page's indicator badge: a small pill in the bottom-right corner saying what's watching the page
// ("● Recording · 12 steps · 5 requests", "● Capturing network · 5 requests"), so the user can see an agent is
// recording in their tab. Installs window.__mcp_setIndicator(key, text); `text` is a string or a function giving one
// (re-read each second, so counts keep up), null removes that line, and the badge goes with the last one. Lines stack.
// It's in its own shadow root (the page's styles can't reach it) and lets every click through.
export function pageIndicator() {
  // Its version, inline: this function runs serialized in the page, where nothing outside it exists.
  const VERSION = 2;
  const w = window;
  if (w.__mcp_setIndicator && w.__mcp_setIndicator.version === VERSION) return;
  const old = w.document.getElementById("__mcp_indicator");
  if (old) old.remove(); // an earlier version's badge
  const lines = new Map();
  let host = null;
  let box = null;
  let timer = null;
  const textOf = (v) => { try { return typeof v === "function" ? v() : v; } catch { return ""; } };
  const render = () => {
    if (!lines.size) {
      if (host) host.remove();
      host = box = null;
      if (timer) clearInterval(timer);
      timer = null;
      return;
    }
    if (!timer && [...lines.values()].some((v) => typeof v === "function")) timer = setInterval(render, 1000);
    if (!host || !host.isConnected) {
      host = document.createElement("div");
      host.id = "__mcp_indicator";
      host.style.cssText = "all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;pointer-events:none";
      const root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
      box = document.createElement("div");
      box.style.cssText = "font:600 12px/1.5 -apple-system,system-ui,sans-serif;color:#fff;background:rgba(200,30,30,.88);" +
        "padding:4px 10px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.25);white-space:nowrap";
      root.appendChild(box);
      (document.body || document.documentElement).appendChild(host);
    }
    box.replaceChildren(...[...lines.values()].map((v) => {
      const line = document.createElement("div");
      line.textContent = textOf(v);
      return line;
    }));
  };
  w.__mcp_setIndicator = (key, text) => {
    if (text) lines.set(key, text);
    else lines.delete(key);
    render();
  };
  w.__mcp_setIndicator.version = VERSION;
}
