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

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

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
    lastActionAt = s.t;
  }
  for (const p of Object.values(out.params)) delete p.field;
  return out;
}
