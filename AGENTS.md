# Agent notes — dsh-agent-enhancer

## UI must imitate official DSH source

When adding or restyling client UI that peers an official Desktop surface, read the matching `@deepseek-ai/dsh-client-ui-*` package (`lib/client.js` + CSS) and reuse primitives (`FileTypeIcon`, guide artwork, folder icons, tokens). Do not invent parallel chrome. See `.cursor/rules/dsh-ui-style.mdc`.

## No orphan features — every capability needs a settings toggle

User-facing capabilities **must** appear under **设置 → 智能体增强 → 功能** with an on/off switch in the **same change set** (`MODULES` + Config + `SETTINGS_FEATURE_GROUPS` + locales + runtime gate). Do not ship always-on surfaces with no switch. See `.cursor/rules/no-orphan-features.mdc`.

## Session delete must stay thorough

When a session is deleted from this plugin, **all plugin-owned persistence for that `sessionId` must be purged**.

Any new feature that writes per-session data under `plugin-data` (or elsewhere keyed by session) **must** register a `SessionCleaner` in the same change set and update `docs/architecture/session-delete.md`. Leaving orphan session files after delete is a product bug.

See: `docs/architecture/session-delete.md`.
