# DSH Agent Enhancer

[English](./README.en.md) | 简体中文

> 让 DeepSeek Harness Desktop **更好写、更好改、更好回退、更看得见用量与上下文**。  
> 能力嵌在官方会话与设置里，默认开启，可在 **设置 → 内置插件 → 智能体增强** 逐项关闭。

[![npm](https://img.shields.io/npm/v/dsh-agent-enhancer.svg)](https://www.npmjs.com/package/dsh-agent-enhancer)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.2--rc.1%20%3C0.3.0-blue)](https://www.npmjs.com/package/dsh-agent-enhancer)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## 功能

预览为 56×56 方图，点击打开原图。语言跟随 Desktop（`zh` / `en`）。

| 能力 | 用法 | 预览 |
| --- | --- | --- |
| **写提示** | `↑↓` / `Alt+R` 历史；右侧 **优化**（可撤销）；回复后 `Tab` 采纳灰字；对话 / 预览 / 编辑器 / 终端划词 → **引用文本** | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/prompt-history.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/prompt-history.png" alt="历史搜索" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/optimize-and-predict.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/optimize-and-predict.png" alt="优化与预测" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/select-to-quote.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/select-to-quote.png" alt="划词引用" width="56" height="56" /></a> |
| **软暂停** | 最新用户气泡工具栏 **暂停 / 恢复**（圆圈内 ‖）：挡住下一步模型调用，省后续 token；当前流式与已发出工具仍跑完。官方 Stop 仍硬中断 | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/soft-pause-action.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/soft-pause-action.png" alt="软暂停" width="56" height="56" /></a> |
| **回退** | 气泡或时间线 **恢复到这里**（可含已跟踪文本文件）→ 预览 → 确认；**+** / `/` **撤销恢复** | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/checkpoint-timeline-entry.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/checkpoint-timeline-entry.png" alt="检查点时间线" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/rollback-entry.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/rollback-entry.png" alt="回滚入口" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/rollback-preview.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/rollback-preview.png" alt="回滚预览" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/undo-restore.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/undo-restore.png" alt="撤销恢复" width="56" height="56" /></a> |
| **工作区** | 预览 **编辑**（Monaco）；指南胶囊 **附加目录**；左侧栏一级 **技能** / **连接器**（对齐官方插件页：列表 · 添加对话框 · 详情；技能 GitHub·Zip 可选 `~/.agents/skills` / `~/.dsh/skills` 或项目对应目录 → `/`；连接器 `mcp.json`）；会话 ⋯ **删除会话** | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/skills-mcp-left-nav.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/skills-mcp-left-nav.png" alt="技能与连接器" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/file-edit-toolbar.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/file-edit-toolbar.png" alt="文件编辑" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/extra-folders.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/extra-folders.png" alt="附加目录" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/session-delete.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/session-delete.png" alt="删除会话" width="56" height="56" /></a> |
| **用量** | **Token 用量** → 模型账单；**设置 → 模型** 看分账号余额 | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/token-usage-meter.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/token-usage-meter.png" alt="Token 用量" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/model-bill.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/model-bill.png" alt="模型账单" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/provider-balance.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/provider-balance.png" alt="分账号余额" width="56" height="56" /></a> |
| **上下文** | 占用环 → 右侧明细；可一键官方 `/compact` | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/context-meter.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/context-meter.png" alt="上下文占用" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/context-details.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/context-details.png" alt="上下文明细" width="56" height="56" /></a> |
| **路由** | 模型列表选 **Auto**；设置映射 Instant / Thinking / Pro | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/auto-model-picker.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/auto-model-picker.png" alt="Auto 选择" width="56" height="56" /></a> <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/auto-routing-settings.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/auto-routing-settings.png" alt="Auto 路由" width="56" height="56" /></a> |
| **设置** | **功能** 十二开关 · **模型与路由** 辅助模型 / Auto · **关于** 更新 | <a href="https://github.com/rebornace/dsh-agent-enhancer/blob/main/docs/images/settings.png"><img src="https://raw.githubusercontent.com/rebornace/dsh-agent-enhancer/main/docs/images/thumbs/settings.png" alt="设置" width="56" height="56" /></a> |

**边界（精简）：** 划词引用不调模型；流式助手与 HTML/PDF/Excel 预览暂不可划词。回退仅跟踪 UTF-8 文本文件，不恢复进程 / 终端 / 未跟踪 / 二进制。附加目录不扩大 Agent 沙箱。技能与连接器：左侧栏一级入口（在「插件」下方；chrome 对齐官方插件页）；技能 GitHub·Zip 安装 / 搜索 / 详情预览 / 卸载（安装目标可选用户/项目 × `.agents/skills` 或 `.dsh/skills`，默认用户 `.agents`），GitHub 可更新、Zip 无更新提示，不代建 AGENTS.md / 空 Skill，调用走官方 `/`；连接器用 `mcp.json` 添加、列表开关、详情看工具。删除会话不可恢复。占用数字为启发式约值；账单「约 ¥」非发票。软暂停挡住的是**暂停之后**尚未发生的模型步；不跨重启保留门闸。

功能页开关：`history` · `optimize` · `predict` · `quote` · `rollback` · `softPause` · `contextInspect` · `usage` · `sessionDelete` · `fileEdit` · `instructionsSkills` · `mcpConnectors`（均默认开；附加目录随 `fileEdit`）。

---

## 安装

面向 **Desktop / `desktop` profile**（不要用 `web` 验收）。装前请退出 Desktop（含托盘）。

| 方式 | 步骤 |
| --- | --- |
| **应用内（推荐）** | **设置 → 插件** 搜索 `dsh-agent-enhancer` / **智能体增强** → 安装 → 重启 |
| **CLI** | `dsh plugin --profile desktop add dsh-agent-enhancer@0.3.7` |
| **开发** | `corepack pnpm install --frozen-lockfile` → `corepack pnpm desktop:link` → 重启；切回线上：`corepack pnpm desktop:npm` |

可选市场：[dsh-market](https://github.com/dsh-market/dsh-market)（应用内搜 `dshmarket`，勿用 `web` profile）。曾装 `dsh-composer-enhancer` 请先卸再装本包。

> 不要 `dsh plugin --profile web …` 往桌面端装；不要对仓库路径 `add` / `link:` / `file:`（Windows Junction 会暴露仓库 `node_modules`，插件会一直关闭）。本地开发用 `desktop:link`（pack 快照，改代码需再 link）。

**卸载：** 应用内卸载，或 `dsh plugin --profile desktop remove dsh-agent-enhancer`。开发安装勿直接 `remove`（可能删源仓库）——先改 profile `package.json` 去掉依赖，再删 `node_modules` 里的链接本身。

**兼容：** DSH `>=0.2.2-rc.1 <0.3.0-0`。

---

## 隐私

- 历史 / 划词引用：不请求模型。优化 / 预测：仅发送必要草稿或最近一轮对话。
- 账单与上下文本地汇总；余额用 Desktop 已存凭据，插件不携带密钥。无遥测上传。
- 与第三方重叠能力只提示，不自动关闭。

---

## 开发

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm check   # typecheck + test + build + 打包校验
```

`src/host/` 服务端 · `src/client/` UI · `tests/` · `lib/` 构建产物 · `docs/images/` 截图（`thumbs/` 由 `scripts/make-readme-thumbs.py` 生成）。

---

## 许可

[MIT](./LICENSE) · [CHANGELOG](./CHANGELOG.md)
