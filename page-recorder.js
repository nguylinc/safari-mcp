// The interaction recorder safari_start_recording installs in a page (rinkagu fork). It watches what the user does -
// clicks, typing, keys, selects, submits, scrolls, in-app navigation - in the capture phase, before the page's own
// handlers, and keeps each action as a step in window.__mcp_recording.steps: what was done, to which element (a
// selector chosen the way Playwright's recorder ranks them: test id, then id, then role and accessible name, then
// label or placeholder, then text, then a CSS path), and the safari-mcp call that does it again.
//
// It runs as page JavaScript (safari.js sends `(${pageRecorder})()`), so it uses nothing from Node. Like the network
// capture, it lives in the page: a full load ends it, in-app navigation doesn't. A password field's value is never
// kept, and nothing is recorded until the recorder is started, or after it's stopped.

export function pageRecorder(command) {
  const w = window;
  const doc = document;
  if (command === "stop") {
    if (!w.__mcp_recording) return "not recording";
    w.__mcp_recording.stop();
    return `stopped: ${w.__mcp_recording.steps.length} steps kept`;
  }
  if (w.__mcp_recording && w.__mcp_recording.active) return `already recording (${w.__mcp_recording.steps.length} steps)`;

  const MAX_STEPS = 2000;
  const started = Date.now();
  const steps = w.__mcp_recording && w.__mcp_recording.steps ? w.__mcp_recording.steps : [];
  const cleanups = [];
  const rec = { active: true, steps, started: new Date(started).toISOString(), stop() {
    rec.active = false;
    for (const undo of cleanups.splice(0)) undo();
  } };
  w.__mcp_recording = rec;

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
    return norm(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || buttonValue || "");
  };

  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== doc.documentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && !/\d{3,}/.test(node.id)) {
        parts.unshift(`#${css(node.id)}`);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (unique(parts.join(" > "), el)) break;
      node = parent;
    }
    return parts.join(" > ");
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
    return step;
  };
  const listen = (target, type, fn) => {
    const wrapped = (event) => { try { fn(event); } catch {} };
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
