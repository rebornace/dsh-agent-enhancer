# DSH Composer Enhancer

**中文：** [README.md](./README.md)

> Make DeepSeek Harness Desktop Composer **easier to write, refine, and roll back**.  
> Prompt history · one-click optimize · next-prompt predict · conversation & file restore — all inside the official Composer.

[![npm](https://img.shields.io/npm/v/dsh-composer-enhancer.svg)](https://www.npmjs.com/package/dsh-composer-enhancer)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.5%20%3C0.3.0-blue)](https://www.npmjs.com/package/dsh-composer-enhancer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## Know it in 30 seconds

| You want to… | Do this |
| --- | --- |
| Revisit a prompt you just sent | `↑` on the first draft line / `↓` on the last, or `Alt+R` |
| Clarify a messy draft | Click **Optimize** on the right; **Undo** if needed |
| Continue after a reply | Press `Tab` to accept the gray suggestion |
| Go back before a turn | Click **Restore to here**, then confirm in the preview |
| Spend less on helper calls | Pick a cheaper model for optimize / predict in settings |
| Turn a feature off | **Settings → Built-in plugins → Composer Enhance** |

Defaults: all four features on. UI language follows Desktop (`zh` / `en`).

---

## Feature map

| Feature | How to use | Notes |
| --- | --- | --- |
| **Prompt history** | First-line `↑`, last-line `↓`; `Esc` to exit; `Alt+R` (`Ctrl+R` where available) | Current loaded session only; `Enter` fills draft without sending; chip drafts ignore history keys |
| **Prompt optimize** | Optimize on the right; selection-only when selected; undo supported | Vague drafts gain detail; specific drafts stay lean; chips kept; optional dedicated model |
| **Next-prompt predict** | Gray suggestion after a reply; `Tab` to accept | At most once per turn; clears on type / session switch |
| **Conversation & file restore** | **Restore to here** on the message; after restore open **+** or type `/`, then **Undo restore** (only while an undo tip remains) | Conversation only, or conversation + tracked files; no processes / terminals / untracked files |

### Settings

**Settings → Built-in plugins → Composer Enhance**

| Toggle | Config key | Default | Effect |
| --- | --- | --- | --- |
| Prompt history | `historyEnabled` | On | `↑↓` and `Alt+R` |
| Prompt optimize | `optimizeEnabled` | On | Optimize / undo; model pill |
| Next-prompt prediction | `predictEnabled` | On | Gray suggestion; model pill |
| Conversation & file restore | `rollbackEnabled` | On | **Restore to here**; **+** / `/` menu **Undo restore** |

Model pills default to **Follow session**, or pick provider / model / reasoning effort. See the UI map below for screenshots.

### UI map

| Screen | What you see | Preview |
| --- | --- | --- |
| History search | `Alt+R` surface and result list | ![History search](https://raw.githubusercontent.com/rebornace/dsh-composer-enhancer/main/docs/images/prompt-history.png) |
| Optimize & predict | Optimize control + gray suggestion after a reply | ![Optimize & predict](https://raw.githubusercontent.com/rebornace/dsh-composer-enhancer/main/docs/images/optimize-and-predict.png) |
| Rollback entry | Restore icon; tooltip **Restore to here** | ![Rollback entry](https://raw.githubusercontent.com/rebornace/dsh-composer-enhancer/main/docs/images/rollback-entry.png) |
| Rollback preview | Conversation to withdraw; conversation-only or + tracked files | ![Rollback preview](https://raw.githubusercontent.com/rebornace/dsh-composer-enhancer/main/docs/images/rollback-preview.png) |
| Undo restore | After restore, open composer **+** or `/`, choose **Undo restore** | ![Undo restore](https://raw.githubusercontent.com/rebornace/dsh-composer-enhancer/main/docs/images/undo-restore.png) |
| Settings · Composer Enhance | Four toggles, model pills, privacy blurb | ![Settings](https://raw.githubusercontent.com/rebornace/dsh-composer-enhancer/main/docs/images/settings.png) |

---

## Install

Quit every Desktop window and tray process before install, upgrade, or uninstall. Use the `desktop` profile (do not validate with `web`).

### npm (recommended)

```sh
dsh plugin --profile desktop add dsh-composer-enhancer@0.1.6
```

You should then see the optimize control and **Composer Enhance** in settings.

### Local directory (development)

`dsh plugin` forwards arguments to pnpm inside the profile directory. Pass an **absolute path** so the profile stores `link:<path>` and adds the bundle:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build
dsh plugin --profile desktop add ((Resolve-Path .).Path)
```

Fully quit and restart Desktop afterward. Later code changes only need `corepack pnpm build` (Desktop loads `lib/`).  
Keep host-shared DSH packages in both `peerDependencies` and `devDependencies`, not in `dependencies`.

---

## Privacy & coexistence

| Topic | Detail |
| --- | --- |
| History | Never calls a model |
| Optimize | Sends draft/selection + latest completed turn |
| Predict | Sends the latest completed turn |
| Cache | In-session memory only |
| Audit | Local `plugin:composer-enhancer/request` (no telemetry upload) |
| Coexistence | Hints only — never auto-disables third-party plugins |

---

## Compatibility

- **DSH:** `>=0.2.1-rc.5 <0.3.0-0` (`0.2.1-rc.3` fails to load)

---

## Uninstall

| Install type | Action |
| --- | --- |
| npm | `dsh plugin --profile desktop remove dsh-composer-enhancer` |
| Local `link:` | **Do not** `remove` / run `pnpm remove` in the profile (can delete the source repo). Follow below |

1. Quit Desktop (including tray)  
2. Edit the **profile** `package.json`: drop this plugin from `dependencies` and `dsh.profile.bundles`  
3. Refresh deps and delete the link only (not its target):

```powershell
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfileDir = Join-Path $DshHome 'profiles\desktop'
dsh plugin --profile desktop install
$PluginLink = Join-Path $ProfileDir 'node_modules\dsh-composer-enhancer'
$Item = Get-Item -LiteralPath $PluginLink -Force -ErrorAction SilentlyContinue
if ($Item -and $Item.LinkType -in @('SymbolicLink', 'Junction')) { $Item.Delete() }
```

---

## Development

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build   # Desktop loads lib/
corepack pnpm check   # typecheck + test + build + pack verify
```

| Path | Contents |
| --- | --- |
| `src/host/` | Model calls, RPC, checkpoint rollback |
| `src/client/` | Composer UI and state machines |
| `tests/` | Vitest |
| `lib/` | Build output |

---

## License

[MIT](./LICENSE)

See [CHANGELOG.md](./CHANGELOG.md) for release notes.
