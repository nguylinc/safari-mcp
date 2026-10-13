// A recording (page-recorder.js) as a saved automation: a JSON file a runner replays step by step with the
// safari-mcp tools (rinkagu fork). The format, which nothing site-specific needs beyond its own file:
//
//   { "name": "...", "description": "...", "server": "<the MCP server to run it through>",
//     "start": "<the URL it starts on, {{params}} allowed>",
//     "params": { "<name>": { "description": "...", "default": "..." } },
//     "steps": [ { "tool": "safari_click", "args": { "text": "Post" }, "expectUrl": "<optional>" }, ... ] }
//
// Every string may hold {{param}} placeholders. What's typed becomes a param (named after its field, its recorded
// value the default; a password gets no default). A step that only follows another (an in-app navigation a click
// caused) becomes that step's `expectUrl`; a form submit (the click or Enter before it does it) is dropped.

// The export is a DRAFT for an agent to tidy before it's saved: the recorder sees events, not intent. Each step it
// can't vouch for carries a `review` list saying why, and the draft's own `review` lists what to check overall.
// Everything under `review` is for that pass and is deleted from the saved file.

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
const CONTROL_ROLES = ["button", "link", "tab", "menuitem", "option", "checkbox", "radio", "switch", "combobox", "textbox"];

// Why a recorded step might not belong in the saved automation, or might not replay.
function reviewStep(s, seenUrls) {
  const notes = [];
  const sel = (s.tool && s.tool.args && s.tool.args.selector) || "";
  if (/:nth-of-type\(/.test(sel)) notes.push("position-based selector: check it matches the intended element on the live page, and anchor it on a stable hook (test id, id, label) if the page has one");
  if (sel && !/[#[.]/.test(sel)) notes.push("selector of tags only: breaks as soon as the page's layout changes");
  if ((s.type === "click" || s.type === "dblclick" || s.type === "right_click") && !CONTROL_ROLES.includes(s.role || "")) notes.push("clicks something that isn't a control: probably incidental, drop it unless the task needs it");
  if (s.type === "scroll") notes.push("a scroll: drop it unless the page only loads what's needed when scrolled");
  if (s.type === "fill" && s.redacted) notes.push("a password: pass it with -p when replaying, never save it in the file");
  if (s.expectUrl && seenUrls.has(s.expectUrl)) notes.push("returns to a page visited earlier: the steps since may be exploration, not the task");
  return notes;
}

// A URL segment that's an id (a ticket, an order, a UUID): one to make a {{param}}.
const idSegments = (url) => {
  try {
    return new URL(url).pathname.split("/").filter((p) => /^(?=.*\d)[A-Za-z0-9-]{6,}$/.test(p));
  } catch {
    return [];
  }
};

export function recordingToAutomation(recording, { name = "", server = "" } = {}) {
  const steps = (recording && recording.steps) || [];
  const first = steps.find((s) => s.url);
  const out = { name, description: "", server, start: first ? first.url : "", params: {}, steps: [] };
  let lastActionAt = -Infinity;
  for (const s of steps) {
    if (!s.tool || s.type === "start" || s.type === "submit") continue;
    if (s.type === "navigate" && out.steps.length && s.t - lastActionAt < 1500) {
      out.steps[out.steps.length - 1].expectUrl = s.url;
      continue;
    }
    const step = { tool: s.tool.name, args: { ...s.tool.args } };
    if (s.name) step.note = `${s.type} ${s.role ? s.role + " " : ""}"${s.name}"`.trim();
    if (s.type === "fill") {
      let key = slug(s.name) || "value";
      for (let i = 2; out.params[key] && out.params[key].field !== s.selector; i++) key = `${slug(s.name) || "value"}_${i}`;
      out.params[key] = s.redacted
        ? { description: `${s.name || "a password field"} (never recorded)`, field: s.selector }
        : { description: s.name || s.selector, default: s.value == null ? "" : String(s.value), field: s.selector };
      step.args.value = `{{${key}}}`;
    }
    out.steps.push(step);
    out.steps[out.steps.length - 1]._recorded = s;
    lastActionAt = s.t;
  }
  for (const p of Object.values(out.params)) delete p.field;

  // The review pass: per step, then overall.
  const seen = new Set([out.start]);
  for (const step of out.steps) {
    const notes = reviewStep({ ...step._recorded, expectUrl: step.expectUrl }, seen);
    if (step.expectUrl) seen.add(step.expectUrl);
    delete step._recorded;
    if (notes.length) step.review = notes;
  }
  const flagged = out.steps.filter((s) => s.review).length;
  out.review = [
    "A draft: tidy it before saving, then delete every `review` (the safari-auto README has the checklist).",
    ...(flagged ? [`${flagged} of ${out.steps.length} steps are flagged.`] : []),
    ...idSegments(out.start).map((id) => `The start URL holds an id (${id}): make it a {{param}} if it varies.`),
    "Each fill's recorded value is its param's default: drop the default if it shouldn't be reused.",
  ];
  return out;
}
