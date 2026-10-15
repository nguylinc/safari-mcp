# safari-mcp, rinkagu fork

Fork of achiya-automation/safari-mcp, used by the rinkagu setup (Claude Code on hetzner driving the user's Safari on the
work Mac). Branch `rinkagu` is what we run; `main` tracks upstream (`git fetch upstream`). Everything about building,
signing, installing and running it lives in the rinkagu repo, not here: `dotfiles/mac/safari-mcp-install.sh` (the daemon),
`dotfiles/mac/safari-mcp-extension.sh` (the Safari extension), `bin/chrome-mcp/safari-personal-tunnel and safari-amazon-tunnel`, and the
`local-tunnel` skill.

## What differs from upstream

One change to tabs: with `SAFARI_MCP_ALLOW_USER_TABS=1`, `safari_switch_tab` by index adopts a tab the user already had open
even when the extension is connected. Upstream only honored the flag in the AppleScript fallback; its extension refused
any tab the session didn't open. The daemon (`index.js`) sends `adoptUserTab` with an explicit-index switch when the
flag is on; the extension (`extension/background.js`, block at the end of the file) adopts the tab, records it in
`storage.local` (`safariMcpAdoptedTabs`, so a restarted worker still knows), and `close_tab` refuses it. Tests:
`test/adopt-user-tabs-extension.test.mjs`.

And `safari_start_network_capture` records enough to replay a request: the method of a `fetch(new Request(...))`
(upstream read only the init, so those POSTs showed as GET), the request's headers and body, and the response's body
(`NETWORK_CAPTURE_JS` in `safari.js`, daemon-side, so no extension rebuild). Tests:
`test/network-capture-details.test.mjs`.

And an interaction recorder, for learning what the user does in a page so it can be automated:
`safari_start_recording` / `safari_get_recording` / `safari_stop_recording` (`index.js`, after the network tools)
install `page-recorder.js` in the page through `safari.js`'s `startRecording` and friends. It records clicks, typing
(one fill per field), special keys and shortcuts, selects, checkboxes, submits, scrolls and in-app navigation, each with
a selector ranked like Playwright's recorder (`packages/injected/src/recorder/recorder.ts` and `selectorGenerator.ts`
in microsoft/playwright, read for this) and the safari-mcp call that replays it; never a password's value. Daemon-side
too, so it ends on a full page load. Tests: `test/page-recorder.test.mjs`. `safari_get_recording` with
`format: "automation"` turns it into a saved-automation JSON (`automation.js`, which documents the format; tests:
`test/automation.test.mjs`) that rinkagu's `bin/safari-auto` replays. While recording or capturing network, the page
shows a small badge saying so (`pageIndicator` in `page-recorder.js`).

A recording captures the page's requests too unless started with `network: false`, and `safari_get_recording` ties
each request to the step that set it off (`linkRecording` in `automation.js`), folding polling into `background`; the
export's review points out a step that made a write, as one an API command could do. The network capture keeps no
auth values: header values like `authorization`, `cookie` and csrf tokens, and URL parameters like `id_token`, are
`<redacted>`, names kept.

The recording and network tools run their page code compiled into the extension: a new `page_script` command runs
named functions in the session's tab (an adopted one included) through `execInTab`, which a page's CSP can't refuse,
where `evaluate`'s script strings need eval or an inline script (mcm.amazon.dev refuses both). The code lives in
`page-scripts.js` (the network capture and readers) and `page-recorder.js`; `scripts/sync-page-scripts.mjs` copies
them into the generated block at the end of `background.js`, and `test/page-scripts.test.mjs` fails while that copy is
stale. So a change to either file needs the sync and an extension rebuild (`dotfiles/mac/safari-mcp-extension.sh
--notarize`). An extension built before `page_script` answers "Unknown command", and the daemon (`runPageSteps` in
`index.js`) then sends the same code as one string through `evaluate`. Upstream's network tools used `runJS`,
AppleScript's `do JavaScript`, which only reaches the profile window's front tab; it's kept as their fallback.

The read-only inspection tools take that path too, with a `receipt`: `safari_get_computed_style`,
`safari_performance_metrics`, `safari_extract_tables` / `_meta` / `_images` / `_links`, `safari_list_indexed_dbs`,
`safari_get_indexed_db`, `safari_inspect_viewport`, `safari_check_pwa` and `safari_analyze_page` (functions in
`page-scripts.js`; the viewport and PWA ones are `injected-validators.js`'s). Upstream ran them only through `runJS`,
which failed with "Tab tracking lost" once the session's tab was in another window of the profile; `runJS` now also
looks for the tab's marker in every window of the profile (`_profileWindows` in `safari.js`). An extension built
before a page function answers "Unknown page script", and `runPageSteps` then sends it through `evaluate`.

`evaluate` runs a script that isn't a valid script (a top-level `await` or `return`) as an async function's body, in
every strategy (`_evalRunner`, content.js's bridge, command-content.js's ISOLATED fallback), and a script that doesn't
parse answers its SyntaxError: upstream's inline-script strategy wrapped it in a plain function, so a top-level `await`
ran nothing and came back as a CSP block. Tests: `test/evaluate-at-most-once.test.mjs`.

Keep the diff this small. Many tests cut functions out of `background.js` by marker (`between(background, "...",
"...")`) and run them with injected helpers: new helpers or top-level statements placed inside such a range, or a new
identifier in `_closeTabForSession`, `_removeOwnedTab` or the `onRemoved` listener, break dozens of tests. Put new code at
the end of the file and call it from outside the cut ranges (see the `close_tab` case).

## Tests

`npm test` needs the dependencies, and `npm install` refuses on Linux (the package is darwin-only):
`npm install --ignore-scripts --force`. A clean tree passes entirely; lint has 20 pre-existing errors (CI gates only `no-undef`), and `npm run typecheck`
hundreds.

## Taking an upstream update

`git fetch upstream && git rebase upstream/main` on `rinkagu`, run the tests, push with
`git -c credential.helper='!gh auth git-credential' push --force-with-lease origin rinkagu`, then rerun the two install
scripts on the Mac (the extension one in Terminal on the Mac, it needs the login keychain). Drop the fork's change if
upstream's extension starts honoring the flag itself; offering it upstream as a PR is the cleaner end state.
