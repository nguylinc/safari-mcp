#!/usr/bin/env node
/**
 * With the extension connected, safari_switch_tab by index adopts a tab the user already had open when the daemon
 * sends adoptUserTab (SAFARI_MCP_ALLOW_USER_TABS), and the extension then refuses to close it. Before, the extension
 * refused the switch whatever the flag said (the flag only reached the AppleScript fallback).
 *
 * Run:  node --test test/adopt-user-tabs-extension.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

function between(src, start, end) {
  const from = src.indexOf(start);
  assert.notEqual(from, -1, `${start} must exist`);
  return src.slice(from, src.indexOf(end, from));
}

test("the daemon sends adoptUserTab only for an explicit index, and only with the opt-in", () => {
  assert.match(index, /\{ index, \.\.\.\(allowUserTabs\(\) \? \{ adoptUserTab: true \} : \{\}\) \}/);
  assert.match(index, /token \? \{ \.\.\.\(index \? \{ index \} : \{\}\), receipt: token \}/, "a receipt switch carries no adoption flag");
});

test("the extension adopts only on adoptUserTab without a receipt, and otherwise still refuses", () => {
  const sw = between(background, "async function _switchTabForSession(", "\nasync function ");
  assert.match(sw, /payload\.adoptUserTab === true && !suppliedReceipt/);
  assert.match(sw, /_markTabAdopted\(target\.id\)/);
  assert.match(sw, /refusing "switch_tab" to tab/);
});

test("an adopted tab is remembered across a worker restart, refused by close_tab, and forgotten when it closes", async () => {
  const helpers = between(background, "const _ADOPTED_TABS_KEY", "\nbrowser.tabs.onRemoved.addListener(");
  const store = {};
  const tabs = [
    { id: 7, index: 0, windowId: 1, url: "https://user.example/a?secret=1" },
    { id: 8, index: 1, windowId: 1, url: "https://own.example/b" },
  ];
  const browser = {
    storage: { local: {
      get: async (key) => ({ [key]: store[key] }),
      set: async (items) => Object.assign(store, items),
    } },
    tabs: { query: async () => tabs },
  };
  const build = () => new Function(
    "browser", "_windowQuery", "_windowForSession", "_safeTabUrl",
    `"use strict"; ${helpers}; return { mark: _markTabAdopted, isAdopted: _isTabAdopted, refuse: _refuseClosingAdoptedTab, adopted: _adoptedTabs };`
  )(browser, (windowId) => ({ windowId }), () => 1, (url) => String(url).split("?")[0]);

  let ext = build();
  await ext.mark(7);
  assert.deepEqual(store.safariMcpAdoptedTabs, [7]);
  ext = build(); // a restarted worker reads the set back from storage
  assert.equal(await ext.isAdopted(7), true);
  assert.equal(await ext.isAdopted(8), false);

  await assert.rejects(ext.refuse("s", tabs[0], {}), /adopted from you.*Close it yourself/, "close by the resolved target");
  await assert.rejects(ext.refuse("s", tabs[1], { index: 1 }), /adopted from you/, "close by explicit index resolves tab 7");
  await assert.rejects(ext.refuse("s", tabs[0], {}), (error) => !/secret=1/.test(error.message), "no query data in the refusal");
  await ext.refuse("s", tabs[1], {}); // an owned tab still closes
  await ext.refuse("s", tabs[1], { index: 2 });

  const closeCase = between(background, '    case "close_tab": {', "\n    case ");
  assert.ok(closeCase.indexOf("_refuseClosingAdoptedTab(") < closeCase.indexOf("_closeTabForSession("), "the refusal runs before anything is released or removed");
  const forget = between(background, "browser.tabs.onRemoved.addListener(async (tabId) => {", "\n});");
  assert.match(forget, /_adoptedTabs\(\)\)\.delete\(tabId\)/);
});
