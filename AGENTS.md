# Agent notes — dsh-agent-enhancer

## Iteration priority

Post-`0.3.8` current P0 is **L7 browser agent**. **v1 main path is landed** (Playwright dedicated browser, `browser_*`, dialog approval, auto-launch, Settings hard-switch; MV3 bridge retired). **Mac platform path is landed** (Safari/WebKit menu + Auto sticky fallback; no Edge on Mac). Step-0 polish landed: real `tabId`, WebKit install hint, needsHuman a11y; chat quote yields to official Desktop. Multi-tab sidebar picker is landed. Skip official viewer URL mirror and sidebar window-reveal chrome (low practical value). Benchmark Cursor / Claude in Chrome. Background notes live in `docs/roadmap.md`, `docs/architecture/browser-agent-playwright.md` and `docs/architecture/browser-agent-browse-parity.md` — local-only files, not in git; read them on this machine, rebuild from the code if a fresh clone lacks them. Still deferred: Checkpoint/Rewind deep polish, approval UX parallel product, memory/prefs product, Computer Use on Windows. Do not ship a second “viewer-only” sidebar browser.

**0.3.14 landed** the browse-parity batch (D6 + A-1…A-6). Rules that must survive future edits:

- **Tab ids** come from `TabRegistry` (monotonic, never reused). Never derive them from `context.pages()` index again — that renumbered tabs on close.
- **Refs** are unique per driver and stored **per tab**, in the driver *and* in `BrowserSessionState`. Do not reintroduce a single per-session ref set: switching back to a tab must not require a re-snapshot, and a ref from another tab must be rejected by name.
- **Guardrails** live next to the tools: read-only tabs (`TabScopeStore`), debug tools (`browserAgentDebugTools`), idle close (`browserAgentIdleClose`), and `diagnose()` for launch failures. Keep the "why + next step" wording; do not replace it with bare error codes. **Mutating browser tools carry the control's name**: `browser_click` / `browser_type` require `label` whenever the snapshot knows a name, the host rejects a label that does not match that ref, and `browser_demo_recipes { action: "run" }` accepts the `site` from `list` and rejects a mismatch. This is not cosmetic: the official permission layer (including the experimental auto-review) sees only the tool name and arguments, so the arguments must say what will be clicked and on which site, or a reviewer cannot authorize the call. **Browser mutations honour the official permission state**: read both the preset (`permissionPresets.current`) and the approval policy (`approval.effectivePolicy`). `read-only` refuses whatever the policy says, `auto` never shows our card (the per-call reviewer is the gate), and policy `never` counts as full access so custom combinations and future presets are not double-asked. `workspace-write` with policy `ask`, or a host missing both services, keeps the local card — the browser sits outside the workspace, so the preset has no opinion there. Do not move the card onto `tools/pre-execute`: the official `ask` has no site-session grant and no control preview, so a multi-step repair would become one card per click. **Unattended runs are granted per flow, not per session**: when the user marks a saved flow 无人值守, running it adds one bounded origin grant (`BrowserApprovalGate.grantOrigin`: same origin as the recording, 20 minutes, 30 actions) that covers the replay and the repairs it needs; it is never persisted, never covers another site, and expires on time or budget. Secrets still stop. Do not derive it from the session's permission mode or from "looks like a scheduled task".
- **Debug capture never records headers, cookies or response bodies**, and console text goes through `redactText` (Chrome writes request URLs into `Failed to load resource` messages).
- **`playwright-core` stays lazily imported**; `lazy-playwright.test.ts` fails if a runtime static import comes back.
- **Demonstration recording** (`browser_demonstrate`) streams user steps to the host through `context.exposeBinding('__dshDemoPush')` — page-side buffering loses everything when the user submits a form and the document navigates. Secret fields are masked on both sides. Recording arms **every tab** of the dedicated browser (plus new ones) and tags each step with `tabId`/`tabUrl`; never narrow it back to the bound page — users carry flows into tabs they opened earlier. The on-page recording badge is styled through CSSOM (a `<style>` element dies under a strict `style-src`), stays `pointer-events:none` + `aria-hidden`, and lives in a shadow root. Replay (`demo-replay.ts`) matches steps to controls by **role + normalized name** against a fresh snapshot and stops at the first step it cannot reproduce honestly — a masked secret, a `<select>`, a missing control. Never let replay report a flow as finished after it stopped; the returned `pending` steps exist so the model can continue. Saved flows outlive the browser run that recorded them, so **never trust `tabId` inside a stored recipe**: replay only switches tabs for multi-tab flows, re-maps ids by page URL, and reopens the recorded `tabUrl` when that tab is gone. Saved flows are agent-callable through `browser_demo_recipes` (list / run by name); a run needs one approval card and reuses the same replay, so `<select>` and checkboxes replay while masked secrets still stop. **Flow parameters** are `${name}` tokens inside a fill value or a navigate URL, with the pre-parameterisation literal kept as the recipe's default, so an untouched flow still runs exactly as recorded; masked fields cannot be parameterised, and a run missing a value stops with the variable names instead of typing the raw token. **Variables are named the way the page names them**: `label` is what the user sees (「开始日期」, may be Chinese) and is derived from the recorded control, while `name` stays a generated token id (`v1`) that only appears inside `${…}`; `vars` keys match either, and `resolveDatePhrase` turns 今天 / 上周 / 上季度 into a local ISO date before the model is ever asked to do date arithmetic. A variable also carries `ask`: the recorded `default` stays (it is what "改回固定" restores) but every run must supply it, and `removeVariable` writes the literal back into the steps rather than leaving a dangling `${…}`. **Repairs** (`demo-heal.ts`) are the only way a saved flow learns after a site change, and they only ever rewrite a control's **locator**: the recorded value, the order and the step count change only by the steps the agent visibly added before the control. A masked secret is never a drift and is never stored, the tracker observes `browser_click` / `browser_type` / `browser_navigate` only while a flow is stopped (same tab, ten-minute window), and `commit()` writes a *proposal*; `resolveHeal({ accept: true })` is the only path that rewrites steps and it keeps a bounded version history so the panel can undo it. **Auto-adapt** is the one exception, and only when the user turned it on in Settings: same origin as the recording, at most three kept repairs per flow per day, locator-only, still undoable. Auto-adapt must never widen into "the flow may do new things"; if that is ever needed it is a new recording, not a heal. Never let a stale `tabId` or `ref` into a repair.

**Web chat (`webChatBridge`)** main path is landed: left-nav embed of `chat.deepseek.com`; Move to workspace = **导入当前对话** (`history_messages` + guest Bearer) or **导入分享链接** (public `share/content`, any account). Same fragment→Session mapping as official `@deepseek-ai/dsh-deepseek-chat-import` (THINK→reasoning, `web_search` / `web_fetch`) when the API payload includes those fragments. Preview lists Q&A only; thinking appears after import. Share rows use `message_id` (not bare `id`); orphan parents fall back to linear import. Do **not** silent-fallback current chat to DOM when the session API fails — fail and suggest share. Do **not** ship a bulk `deepseek_data-*.zip` product line (use official experimental「DeepSeek 会话导入」). Do **not** reintroduce account-bulk scraping. Background: `docs/architecture/web-chat-bridge.md` (local-only). Screenshots: `docs/images/web-chat-left-nav.png`, `docs/images/web-chat-to-workspace.png`.

## Browser agent — platform rules

| OS | Settings / sidebar choices | Auto order |
| --- | --- | --- |
| **macOS** | `auto` · `chrome` · `safari` (no Edge) | WebKit → Chrome |
| **Windows** | `auto` · `chrome` · `edge` | Edge → Chrome |
| **Linux** | `auto` · `chrome` | Chrome |

- Safari option launches Playwright **WebKit** (Safari engine), **not** branded `Safari.app`. Require `/Applications/Safari.app` as a platform gate; require `npx playwright install webkit` for the engine binary.
- Cross-OS coerce: saved `edge` on Mac → `safari`; saved `safari` on Windows → `edge`.
- Auto isolates profiles per channel (`profile-auto-webkit`, `profile-auto-chrome`, …). Never share one user-data-dir across Chromium and WebKit.
- **Sticky Auto:** once Auto successfully falls back (e.g. to Chrome), keep that channel for the running driver. Do **not** tear down every Agent tool tick just because WebKit is listed first — that caused open/close flaps.
- Mac Chrome/Safari candidates check both `/Applications` and `~/Applications`.

## Mac Desktop link

```bash
npx playwright install webkit   # if testing Safari / Mac Auto
./scripts/mac-desktop-link.sh   # quits Harness → pnpm desktop:link
```

Bundled CLI (when not on PATH):  
`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`  
Also try `~/Applications` and `DSH_CLI` when scripting Desktop link.

Do **not** reintroduce in-plugin self-update (About → check/apply via `dsh plugin add`); use official Desktop plugin updates.

## UI must imitate official DSH source

When adding or restyling client UI that peers an official Desktop surface, read the matching `@deepseek-ai/dsh-client-ui-*` package (`lib/client.js` + CSS) and reuse primitives (`FileTypeIcon`, guide artwork, folder icons, tokens). Do not invent parallel chrome. See `.cursor/rules/dsh-ui-style.mdc`.

**Only reference design tokens the theme defines.** A `var(--dsw-…)` with an unknown name is dropped, so the declaration silently never applies: that is how the browser approval banner lost its background and rendered see-through over the page (`--dsw-alias-bg-elevated` was never a token). `tests/client-design-tokens.test.ts` fails if `styles.module.css` mentions a token missing from `tests/fixtures/dsh-theme-tokens.txt`; refresh that fixture from `@deepseek-ai/dsh-client-ui-theme` when the Desktop host moves.

## Backlog admission: prove the official surface does not do it

Before planning or implementing a roadmap item, write its three-line duplicate check: the official package/UI surface that would own it, the evidence (screenshot, code path, or test), and what stays uncovered. If the third line is empty, delete the item from the roadmap instead of building it — a plan for a duplicate feature is the most expensive kind of plan. Check by **surface**, not by feature name: L1 (run progress) was justified with "official Todos only cover the plan", missed the conversation's activity block, and had to be reverted after shipping.

Plans live in `docs/plans/<name>.md` (local-only); the check is the first section.

## No orphan features — every capability needs a settings toggle

User-facing capabilities **must** appear under **设置 → 智能体增强 → 功能** with an on/off switch in the **same change set** (`MODULES` + Config + `SETTINGS_FEATURE_GROUPS` + locales + runtime gate). Do not ship always-on surfaces with no switch. See `.cursor/rules/no-orphan-features.mdc`.

## Persisted data must not hold volatile handles

Anything saved and re-run later (demo recipes, bookmarks, caches) must store semantics, not runtime handles: no `tabId`, no element `ref`, no page/window/process object, no temp path, no per-run counter. Re-resolve from the URL / role+name / current DOM at run time. When the target is gone, stop at the exact step with a reason; do not poke at a stale handle.

This is not theoretical: saved demo recipes originally kept the recording's `tabId`, so after a restart replay died on step 1 with "tab 1 is no longer open". Recipes now drop `tabId` on save, keep `tabUrl`, and match live tabs by page URL. The planning template (`docs/plans/_template.md`, §4) carries the same checklist.

## Session delete must stay thorough

When a session is deleted from this plugin, **all plugin-owned persistence for that `sessionId` must be purged**.

Any new feature that writes per-session data under `plugin-data` (or elsewhere keyed by session) **must** register a `SessionCleaner` in the same change set and update `docs/architecture/session-delete.md`. Leaving orphan session files after delete is a product bug.

See: `docs/architecture/session-delete.md` (local-only).

## Publishing needs an explicit ask

Shipping is a separate decision from building. **Never run `pnpm publish`, push a `v*` tag, or create a GitHub release unless the user asked for a release in that turn.** Finish the change, run `pnpm check`, and report the version you *would* publish (plus what changed); wait for a go-ahead. Batch related work into one release unless the user asks for separate ones — ten patch releases in two days is a process failure, not shipping speed, and published versions cannot be taken back cleanly.

## Docs policy

Publish only what stays true: `README` (what the plugin does and does not do), `CHANGELOG` (what shipped), `AGENTS.md` (invariants), tests. Keep plans and decision logs local under `docs/` (ignored by git) — an AI-written roadmap in a public repo reads as a promise and rots fastest. Do not add `docs/roadmap.md` or `docs/architecture/` to git without an explicit decision to publish them.

## CI

`.github/workflows/ci.yml` runs on push to `main` and on PRs: `pnpm check` (typecheck + vitest + build + pack verification) on Ubuntu, plus typecheck/tests on Windows. The integration suite under `tests/` ships with the repo (sanitized: no real home paths, tokens or chat content — keep it that way); `vitest.global-setup.ts` (tracked) builds `lib/` once when it is missing.

## Host version policy

We stay on `0.x` while the host is pre-stable. The plugin is an extension of DeepSeek Desktop, so it must not claim more stability than the platform it extends: no `1.0.0` until the Desktop host leaves pre-release. A milestone version (`0.4.0`) is still the right way to close a batch and put the patch noise behind one number.

Desktop ships its own `@deepseek-ai/*` packages, so the plugin has two version lines: `devDependencies` pin the newest candidate we build and test against (currently `0.2.2-rc.5`), while `peerDependencies` accept `>=0.2.2-rc.2 <0.3.0-0` so a Desktop that has not taken the latest candidate still loads the plugin. `tests/package.test.ts` enforces that shape (peer mirrors dev exactly, or the range; dev is always a concrete version). When a new candidate lands, check its real source diff — the GitHub compare API caps at 300 files, so pull both tag tarballs and hash-compare the trees instead — then bump devDeps only.
