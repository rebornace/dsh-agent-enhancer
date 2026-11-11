# DSH Agent Enhancer

English | [简体中文](./README.md)

> Make DeepSeek Harness Desktop **easier to write, refine, roll back, and see usage & context**.  
> Features live inside the official chat and settings. Defaults on; turn off individually under **Settings → Built-in plugins → Agent Enhancer**.

[![npm](https://img.shields.io/npm/v/dsh-agent-enhancer.svg)](https://www.npmjs.com/package/dsh-agent-enhancer)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.2--rc.1%20%3C0.3.0-blue)](https://www.npmjs.com/package/dsh-agent-enhancer)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## Features

Previews are 56×56 squares — click for the full image. UI language follows Desktop (`zh` / `en`).

| Capability | How | Preview |
| --- | --- | --- |
| **Write** | `↑↓` / `Alt+R` input history; **Optimize** (undo); after a reply, `Tab` for Suggest next; select in chat / preview / editor / terminal → **Quote text** | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/prompt-history.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/prompt-history.png" alt="Input history" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/optimize-and-predict.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/optimize-and-predict.png" alt="Optimize & suggest" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/select-to-quote.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/select-to-quote.png" alt="Quote" width="56" height="56" /></a> |
| **Pause next** | **Pause / Resume** on the latest user message: hold the next model call to save tokens; the current reply and in-flight tools still finish. Official Stop remains a hard interrupt | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/soft-pause-action.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/soft-pause-action.png" alt="Pause next" width="56" height="56" /></a> |
| **Run notifications** | Finish / approval / error alerts; default **when unfocused** (dual-monitor or another app), or background-only / always; OS notification while away, toast after focus if needed | |
| **Checkpoint restore** | Bubble or timeline **Restore to here** (optional tracked text files) → preview → confirm; **+** / `/` **Undo restore** | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/checkpoint-timeline-entry.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/checkpoint-timeline-entry.png" alt="Timeline" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/rollback-entry.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/rollback-entry.png" alt="Restore entry" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/rollback-preview.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/rollback-preview.png" alt="Preview" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/undo-restore.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/undo-restore.png" alt="Undo" width="56" height="56" /></a> |
| **Workspace** | Preview **Edit** (Monaco); guide capsule **Extra folders**; left-nav **Skills** / **Connectors** (Plugins-page chrome: list · Add dialog · detail; Skills GitHub·Zip → `~/.agents/skills` → `/`; Connectors via `mcp.json`); session ⋯ **Delete session** | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/skills-mcp-left-nav.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/skills-mcp-left-nav.png" alt="Skills & connectors" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/file-edit-toolbar.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/file-edit-toolbar.png" alt="Edit" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/extra-folders.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/extra-folders.png" alt="Extra folders" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/session-delete.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/session-delete.png" alt="Delete session" width="56" height="56" /></a> |
| **Token usage** | Composer entry → usage summary; **Settings → Models** for account balance | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/token-usage-meter.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/token-usage-meter.png" alt="Token usage" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/model-bill.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/model-bill.png" alt="Usage" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/provider-balance.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/provider-balance.png" alt="Balance" width="56" height="56" /></a> |
| **Context usage** | Meter → right-pane details; one-click context compact | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/context-meter.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/context-meter.png" alt="Meter" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/context-details.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/context-details.png" alt="Details" width="56" height="56" /></a> |
| **Routing** | Pick **Auto** in the model list; map Instant / Thinking / Pro in settings | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/auto-model-picker.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/auto-model-picker.png" alt="Auto picker" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/auto-routing-settings.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/auto-routing-settings.png" alt="Auto routing" width="56" height="56" /></a> |
| **Web chat** | Enable in settings (**on by default**) → left nav opens official web chat; **Move to workspace** chooses **This conversation** or a **Share link** → preview → **new** session in the chosen workspace (create workspace when needed). Page capture may be incomplete; prefer a share link for a full single chat; does not connect web quota to the local API | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/web-chat-left-nav.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/web-chat-left-nav.png" alt="Web chat nav" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/web-chat-to-workspace.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/web-chat-to-workspace.png" alt="Move to workspace" width="56" height="56" /></a> |
| **Browser control** | Enable in settings (off by default) → pick dedicated browser: **Mac** Auto / Chrome / Safari; **Windows** Auto / Chrome / Edge. Chat or Alt+click can **auto-launch** a dedicated window; Settings/sidebar switch applies immediately; mutations need approval; login wall “I’m done”. Not the official sidebar browser | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/browser-agent-guide.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/browser-agent-guide.png" alt="Browser control" width="56" height="56" /></a> |
| **Settings** | **Features** fifteen toggles · **Models & routing** helpers / Auto · **About** updates | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/settings.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/settings.png" alt="Settings" width="56" height="56" /></a> |

**Limits (short):** Quote never calls a model; streaming replies and HTML/PDF/Excel previews are not quote sources yet. Checkpoint restore covers conversation and tracked text files only — not processes / terminals / untracked / binaries. Extra folders do not expand what the agent can access. Skills and Connectors live in the left sidebar under Plugins; install skills from GitHub / Zip and invoke with `/`; manage connectors with `mcp.json`. Session delete is permanent. Context usage is approximate; “≈ ¥” is not an invoice. Pause next only holds **later** model calls. Run notifications use the system notification center, or a toast after you return. Web chat embeds `chat.deepseek.com` (sign in on the page the first time); Move to workspace supports This conversation or a Share link (creates a titled workspace session); does not connect web quota to the local API. Browser control uses a platform dedicated window (Mac: Safari/WebKit or Chrome; Windows: Chrome or Edge; separate profile can keep login). On Mac, the Safari option drives Playwright WebKit (Safari engine), **not** everyday Safari.app; chat or Alt+click can auto-launch; mutations need approval; does not bypass login walls; turning the toggle off removes tools and closes the dedicated browser.

Feature toggles: `history` · `optimize` · `predict` · `quote` · `rollback` · `softPause` · `runAlerts` · `contextInspect` · `usage` · `sessionDelete` · `fileEdit` · `instructionsSkills` · `mcpConnectors` · `webChatBridge` (all default on; Extra folders follows `fileEdit`; web chat: move to workspace — current chat / share link; create workspace when moving) · `browserAgent` (**off by default**; Mac: `auto`/`chrome`/`safari`; Windows: `auto`/`chrome`/`edge`; mutation approval is dialog-only).

---

## Install

Targets **Desktop / the `desktop` profile** (do not validate with `web`). Quit Desktop (including tray) first.

| Method | Steps |
| --- | --- |
| **In-app (recommended)** | **Settings → Plugins** → search `dsh-agent-enhancer` / **Agent Enhancer** → install → restart |
| **CLI** | `dsh plugin --profile desktop add dsh-agent-enhancer@0.3.10` |
| **Dev** | `corepack pnpm install --frozen-lockfile` → `corepack pnpm desktop:link` → restart; back to npm: `corepack pnpm desktop:npm` |

Optional market: [dsh-market](https://github.com/dsh-market/dsh-market) (in-app search `dshmarket`; do not use the `web` profile). Remove legacy `dsh-composer-enhancer` before installing this package.

> Do not install into Desktop with `dsh plugin --profile web …`. Do not `add` / `link:` / `file:` a repo path (Windows Junctions expose `node_modules` and leave the plugin off). Use `desktop:link` (pack snapshot; re-link after code changes).

**Uninstall:** in-app remove, or `dsh plugin --profile desktop remove dsh-agent-enhancer`. For a linked dev install, do not `remove` blindly — edit the profile `package.json`, then delete only the `node_modules` link.

**Compatibility:** DSH `>=0.2.2-rc.1 <0.3.0-0`.

---

## Privacy

- History / select-to-quote: no model calls. Optimize / predict: only the needed draft or latest completed turn.
- Bill and context stay local; balances use Desktop-stored credentials — this plugin ships no keys. No telemetry upload.
- Overlap with third-party plugins is hinted only; never auto-disabled.

---

## Development

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm check   # typecheck + test + build + pack verify
```

**Mac Desktop link:**

```bash
# Optional: Safari/WebKit engine (needed for Auto-prefer / locked Safari)
npx playwright install webkit

# Quit Desktop (including tray), then link the local pack
./scripts/mac-desktop-link.sh
# Equivalent: corepack pnpm desktop:link → restart DeepSeek Harness
```

If `dsh` is not on PATH on Mac, use the app-bundled CLI:  
`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`  
(plugin update probing also tries this path).

`src/host/` · `src/client/` · `tests/` · `lib/` build output · `docs/images/` screenshots (`thumbs/` via `scripts/make-readme-thumbs.py`).

**Next iterations:** see [docs/roadmap.md](./docs/roadmap.md) (current P0: browser agent — real login state, step approvals; bar = Cursor / Claude; Rewind / approval / memory deferred).

---

## License

[MIT](./LICENSE) · [CHANGELOG](./CHANGELOG.md) · [Roadmap](./docs/roadmap.md)
