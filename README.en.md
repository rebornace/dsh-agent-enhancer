# DSH Agent Enhancer

English | [简体中文](./README.md)

> Make DeepSeek Harness Desktop **easier to write, refine, roll back, and see usage & context**.  
> Features live inside the official chat and settings. Defaults on; turn off individually under **Settings → Built-in plugins → Agent Enhance**.

[![npm](https://img.shields.io/npm/v/dsh-agent-enhancer.svg)](https://www.npmjs.com/package/dsh-agent-enhancer)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.2--rc.1%20%3C0.3.0-blue)](https://www.npmjs.com/package/dsh-agent-enhancer)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## Features

Previews are 56×56 squares — click for the full image. UI language follows Desktop (`zh` / `en`).

| Capability | How | Preview |
| --- | --- | --- |
| **Write** | `↑↓` / `Alt+R` history; **Optimize** (undo); after a reply, `Tab` for gray predict; select in chat / preview / editor / terminal → **Quote text** | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/prompt-history.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/prompt-history.png" alt="History" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/optimize-and-predict.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/optimize-and-predict.png" alt="Optimize & predict" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/select-to-quote.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/select-to-quote.png" alt="Quote" width="56" height="56" /></a> |
| **Soft pause** | **Pause / Resume** on the latest user bubble toolbar (‖ in a circle): hold the next model step to save later tokens; the current stream and in-flight tools still finish. Official Stop remains a hard interrupt | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/soft-pause-action.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/soft-pause-action.png" alt="Soft pause" width="56" height="56" /></a> |
| **Restore** | Bubble or timeline **Restore to here** (optional tracked text files) → preview → confirm; **+** / `/` **Undo restore** | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/checkpoint-timeline-entry.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/checkpoint-timeline-entry.png" alt="Timeline" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/rollback-entry.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/rollback-entry.png" alt="Rollback entry" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/rollback-preview.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/rollback-preview.png" alt="Preview" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/undo-restore.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/undo-restore.png" alt="Undo" width="56" height="56" /></a> |
| **Workspace** | Preview **Edit** (Monaco); guide capsule **Extra folders**; left-nav **Skills** / **Connectors** (Plugins-page chrome: list · Add dialog · detail; Skills GitHub·Zip → `~/.agents/skills` → `/`; Connectors via `mcp.json`); session ⋯ **Delete session** | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/skills-mcp-left-nav.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/skills-mcp-left-nav.png" alt="Skills & connectors" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/file-edit-toolbar.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/file-edit-toolbar.png" alt="Edit" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/extra-folders.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/extra-folders.png" alt="Extra folders" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/session-delete.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/session-delete.png" alt="Delete session" width="56" height="56" /></a> |
| **Usage** | **Token usage** → model bill; **Settings → Models** for per-provider balance | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/token-usage-meter.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/token-usage-meter.png" alt="Token usage" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/model-bill.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/model-bill.png" alt="Bill" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/provider-balance.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/provider-balance.png" alt="Balance" width="56" height="56" /></a> |
| **Context** | Meter → right-pane details; one-click official `/compact` | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/context-meter.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/context-meter.png" alt="Meter" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/context-details.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/context-details.png" alt="Details" width="56" height="56" /></a> |
| **Routing** | Pick **Auto** in the model list; map Instant / Thinking / Pro in settings | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/auto-model-picker.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/auto-model-picker.png" alt="Auto picker" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/auto-routing-settings.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/auto-routing-settings.png" alt="Auto routing" width="56" height="56" /></a> |
| **Settings** | **Features** twelve toggles · **Models & routing** helpers / Auto · **About** updates | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/settings.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/settings.png" alt="Settings" width="56" height="56" /></a> |

**Limits (short):** Quote never calls a model; streaming assistant replies and HTML/PDF/Excel previews are not quote sources yet. Restore tracks UTF-8 text only — no processes / terminals / untracked / binaries. Extra folders do not widen the Agent sandbox. Skills and Connectors are left-nav peers under Plugins (Plugins-page chrome): Skills use GitHub·Zip install / search / detail / uninstall (default `~/.agents/skills`; GitHub can update, Zip cannot; no AGENTS.md or empty stubs; invoke via `/`); Connectors add via `mcp.json`, toggle in the list, tools on the detail page. Session delete is permanent. Context numbers are heuristic; bill “≈ ¥” is not an invoice. Soft pause holds **later** model steps after pause; the gate is not kept across restarts.

Feature toggles: `history` · `optimize` · `predict` · `quote` · `rollback` · `softPause` · `contextInspect` · `usage` · `sessionDelete` · `fileEdit` · `instructionsSkills` · `mcpConnectors` (all default on; Extra folders follows `fileEdit`).

---

## Install

Targets **Desktop / the `desktop` profile** (do not validate with `web`). Quit Desktop (including tray) first.

| Method | Steps |
| --- | --- |
| **In-app (recommended)** | **Settings → Plugins** → search `dsh-agent-enhancer` / **Agent Enhance** → install → restart |
| **CLI** | `dsh plugin --profile desktop add dsh-agent-enhancer@0.3.5` |
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

`src/host/` · `src/client/` · `tests/` · `lib/` build output · `docs/images/` screenshots (`thumbs/` via `scripts/make-readme-thumbs.py`).

---

## License

[MIT](./LICENSE) · [CHANGELOG](./CHANGELOG.md)
