# Agent notes — dsh-agent-enhancer

## Iteration priority

Post-`0.3.8` current P0 is **L7 browser agent**. **v1 main path is landed** (Playwright dedicated browser, `browser_*`, dialog approval, auto-launch, Settings hard-switch; MV3 bridge retired). **Mac platform path is landed** (Safari/WebKit menu + Auto sticky fallback; no Edge on Mac). Step-0 polish landed: real `tabId`, WebKit install hint, needsHuman a11y; chat quote yields to official Desktop. Multi-tab sidebar picker is landed. Skip official viewer URL mirror and sidebar window-reveal chrome (low practical value). Benchmark Cursor / Claude in Chrome. See [`docs/roadmap.md`](docs/roadmap.md) and [`docs/architecture/browser-agent-playwright.md`](docs/architecture/browser-agent-playwright.md). Still deferred: Checkpoint/Rewind deep polish, approval UX parallel product, memory/prefs product, Computer Use on Windows. Do not ship a second “viewer-only” sidebar browser.

**Web chat (`webChatBridge`)** main path is landed: left-nav embed of `chat.deepseek.com`; Move to workspace = **导入当前对话** (`history_messages` + guest Bearer) or **导入分享链接** (public `share/content`, any account). Same fragment→Session mapping as official `@deepseek-ai/dsh-deepseek-chat-import` (THINK→reasoning, `web_search` / `web_fetch`) when the API payload includes those fragments. Preview lists Q&A only; thinking appears after import. Share rows use `message_id` (not bare `id`); orphan parents fall back to linear import. Do **not** silent-fallback current chat to DOM when the session API fails — fail and suggest share. Do **not** ship a bulk `deepseek_data-*.zip` product line (use official experimental「DeepSeek 会话导入」). Do **not** reintroduce account-bulk scraping. See [`docs/architecture/web-chat-bridge.md`](docs/architecture/web-chat-bridge.md). Screenshots: `docs/images/web-chat-left-nav.png`, `docs/images/web-chat-to-workspace.png`.

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
Host update probing (`probeDsh`) also tries App + `~/Applications` + `DSH_CLI`.

## UI must imitate official DSH source

When adding or restyling client UI that peers an official Desktop surface, read the matching `@deepseek-ai/dsh-client-ui-*` package (`lib/client.js` + CSS) and reuse primitives (`FileTypeIcon`, guide artwork, folder icons, tokens). Do not invent parallel chrome. See `.cursor/rules/dsh-ui-style.mdc`.

## No orphan features — every capability needs a settings toggle

User-facing capabilities **must** appear under **设置 → 智能体增强 → 功能** with an on/off switch in the **same change set** (`MODULES` + Config + `SETTINGS_FEATURE_GROUPS` + locales + runtime gate). Do not ship always-on surfaces with no switch. See `.cursor/rules/no-orphan-features.mdc`.

## Session delete must stay thorough

When a session is deleted from this plugin, **all plugin-owned persistence for that `sessionId` must be purged**.

Any new feature that writes per-session data under `plugin-data` (or elsewhere keyed by session) **must** register a `SessionCleaner` in the same change set and update `docs/architecture/session-delete.md`. Leaving orphan session files after delete is a product bug.

See: `docs/architecture/session-delete.md`.
