# safari-mcp, rinkagu fork

Fork of achiya-automation/safari-mcp, used by the rinkagu setup (Claude Code on hetzner driving the user's Safari on the
work Mac). Branch `rinkagu` is what we run; `main` tracks upstream (`git fetch upstream`). Everything about building,
signing, installing and running it lives in the rinkagu repo, not here: `dotfiles/mac/safari-mcp-install.sh` (the daemon),
`dotfiles/mac/safari-mcp-extension.sh` (the Safari extension), `bin/chrome-mcp/safari-real-tunnel`, and the
`local-tunnel` skill.

## What differs from upstream

One change: with `SAFARI_MCP_ALLOW_USER_TABS=1`, `safari_switch_tab` by index adopts a tab the user already had open
even when the extension is connected. Upstream only honored the flag in the AppleScript fallback; its extension refused
any tab the session didn't open. The daemon (`index.js`) sends `adoptUserTab` with an explicit-index switch when the
flag is on; the extension (`extension/background.js`, block at the end of the file) adopts the tab, records it in
`storage.local` (`safariMcpAdoptedTabs`, so a restarted worker still knows), and `close_tab` refuses it. Tests:
`test/adopt-user-tabs-extension.test.mjs`.

Keep the diff this small. Many tests cut functions out of `background.js` by marker (`between(background, "...",
"...")`) and run them with injected helpers: new helpers or top-level statements placed inside such a range, or a new
identifier in `_closeTabForSession`, `_removeOwnedTab` or the `onRemoved` listener, break dozens of tests. Put new code at
the end of the file and call it from outside the cut ranges (see the `close_tab` case).

## Tests

`npm test` needs the dependencies, and `npm install` refuses on Linux (the package is darwin-only):
`npm install --ignore-scripts --force`. A clean tree passes entirely; lint has three pre-existing errors.

## Taking an upstream update

`git fetch upstream && git rebase upstream/main` on `rinkagu`, run the tests, push with
`git -c credential.helper='!gh auth git-credential' push --force-with-lease origin rinkagu`, then rerun the two install
scripts on the Mac (the extension one in Terminal on the Mac, it needs the login keychain). Drop the fork's change if
upstream's extension starts honoring the flag itself; offering it upstream as a PR is the cleaner end state.
