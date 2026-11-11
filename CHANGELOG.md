# Changelog

## Unreleased

## 0.3.11 - 2026-11-11

### Added

- **浏览器 Agent · 平台菜单：** Mac 提供 `auto` / `chrome` / `safari`（不再提供 Edge）；Windows 仍为 `auto` / `chrome` / `edge`。旧配置跨平台自动映射（Mac 上 `edge`→`safari`，Windows 上 `safari`→`edge`）。
- **浏览器 Agent · Safari：** Mac 锁定 / Auto 优先走 Playwright **WebKit**（Safari 引擎专用窗口；Playwright 无法驱动 Safari.app 本体）。需本机有 Safari，且已安装 `npx playwright install webkit`。
- **更新探测 · Mac CLI：** `probeDsh` / 自动更新会尝试 App 包内 `…/DeepSeek Harness.app/…/runtime/cli/bin/dsh`、`~/Applications/…`、`DSH_CLI`，不再只依赖 PATH 上的裸 `dsh`。
- **Mac 开发脚本：** `scripts/mac-desktop-link.sh`（退出 Desktop → `desktop:link`）。

### Changed

- **浏览器 Agent · Auto 顺序：** Mac `webkit`→`chrome`；Windows 仍 `msedge`→`chrome`。Auto 按通道隔离 profile（`profile-auto-webkit` / `profile-auto-chrome` / …），避免 Chromium 与 WebKit 共用 user-data。
- **浏览器路径：** Mac 候选含 `/Applications` 与 `~/Applications`（Chrome / Canary / Chromium；Safari）。

### Fixed

- **浏览器 Agent · Auto 开/关循环：** Auto 回退到 Chrome 后，每轮 Agent 工具仍强制要求第一通道 WebKit，导致反复拆窗重开。现接受偏好允许的任一已启动通道，并在成功回退后保持粘性。
- **构建：** `tsconfig.build.json` 排除 `src/**/*.test.ts(x)`，测试文件不再进入声明产物。
- **跨平台路径：** Mac App / dsh CLI 候选路径改用 `path.posix.join`，避免在 Windows 上跑 Darwin 单测时被改成 `\`。

### Docs

- README 中英文钉到 `0.3.11`；AGENTS：浏览器平台差异、Safari/WebKit 边界、Mac 开发联调说明。

## 0.3.10 - 2026-11-09

### Added

- **网页聊天（webChatBridge）：** 左栏内嵌 `chat.deepseek.com`；「转到工作区」支持当前对话 / 分享链接 → 预览 → 在所选工作区新建带标题会话（可新建工作区）；登录态本地快照；导入写入 v4 受保护 `system/message` 头，避免重开报错。

### Docs

- README 中英文钉到 `0.3.10`；补充网页聊天入口与转到工作区配图。

## 0.3.9 - 2026-11-09

### Changed

- **浏览器 Agent 驱动：** 关键路径改为 **Playwright-core 持久化 Context**（独立 `user-data-dir` + 显式 Chrome/Edge）。MV3 扩展桥退役，源码归档 `extensions/chrome-legacy/`（不进发布包）。
- **浏览器 Agent 交互：** 去掉「启动浏览器 Agent」弹框；对话 `browser_*` / Alt+点击自动启动。设置或侧栏切换 Chrome/Edge 立刻同步（已运行则硬切）；右侧栏可选手动启动与看状态。
- **浏览器 Agent 设置：** 仅保留功能开关 + `browserAgentBrowser`（`auto` / `chrome` / `edge`）。变更批准只走弹框；去掉单独批准级别与信任源白名单设置项。

### Added

- **浏览器 Agent（v1）：** `browser_*` 工具集、变更批准弹框、登录墙「我已完成」、会话↔tab / Follow·Stay、Alt+点击链接、页引用、system-prompt 引导；会话删除内存 cleaner `browser-agent`。
- **浏览器 Agent 切换：** 分槽 profile；Windows 孤儿进程杀除（命令行斜杠归一化）；`browserAgentSetBrowser` live 同步；工具打开前 `alignToPreference`。

### Docs

- README 中英文钉到 `0.3.9`；路线图与架构说明与 Playwright 路径对齐。

## 0.3.8 - 2026-11-08

### Added

- **运行提醒：** 长跑结束、等待批准/提问/计划审阅或会话出错时拉回注意力；默认级别「失焦时」（覆盖双屏 / 同屏其他应用）；可选「仅后台」「总是」；失焦时经 Host 走 Electron / Windows 通知中心（AUMID 归在 DeepSeek Harness，不再显示为 PowerShell；不再依赖页面 Web Notification），不可用则回焦后 Toast；设置项 `runAlertsEnabled` + `runAlertsLevel`。

### Docs

- README 中英文钉到 `0.3.8`。

## 0.3.7 - 2026-11-08

### Added

- **技能安装进度：** GitHub 安装显示阶段（解析 / 下载 / 解压 / 克隆 / 写入）与可选字节进度，可取消。
- **技能安装目标：** 添加面板可选用户/项目 × `.agents/skills` 或 `.dsh/skills`（默认用户 `.agents`）。

### Fixed

- **skills-manager 原路径：** 覆盖安装不再先 purge 再跳过；junction 只 unlink，避免清空 central / 丢失 `source_ref`。
- **安装报「没有权限」：** 受保护路径静默跳过；可行动错误详情不再被笼统权限文案吞掉。
- 占用路径（EPERM/EIO）与网络/代理失败的提示更准确；安装临时目录不再污染技能列表。

### Docs

- README 中英文钉到 `0.3.7`；技能安装目标说明同步。

## 0.3.6 - 2026-11-07

### Added

- **软暂停：** 最新用户气泡工具栏暂停/恢复（‖）；Host `agent/pre-step` 门闸挡住下一步模型调用以节省后续 token；官方 Stop 仍硬中断并清门闸。设置项 `softPauseEnabled`（默认开）。
- **技能：** 左侧栏一级入口（`sidebar.panellist` + `main`，chrome 对齐官方插件页：列表 · 添加对话框 · 详情）；GitHub/`owner/repo` 或 Zip 安装到 `~/.agents/skills`；GitHub 可检测更新；安装后用官方 `/` 调用。设置项 `instructionsSkillsEnabled`（默认开）。
- **连接器（MCP）：** 左侧栏一级入口（与技能同套 Plugins 页 chrome）；`mcp.json` 添加 Stdio/Remote，列表 `Switch`，详情看工具；经官方 `dsh-mcp-client` 挂载。设置项 `mcpConnectorsEnabled`（默认开）。

### Changed

- 技能 / 连接器管理壳改为对齐 `dsh-client-ui-plugin-manager`（去掉 SegmentedControl 管理壳；添加走官方 `Modal`）。

### Removed

- **停止后继续执行：** 硬停后再发续跑文案不省 token，且无法替换官方发送/停止主按钮；已拆除（由步间软暂停替代续跑路径）。

### Docs

- README 中英文补技能/连接器左侧栏与软暂停工具栏截图；功能表与边界说明同步十二开关（含 `mcpConnectors`）。
- README 中英文钉到 `0.3.6`。

## 0.3.5 - 2026-11-06

### Added

- **划词引用：** 对话正文（已落定）、官方文件预览、Monaco 编辑器、侧栏终端划词后可点「引用文本」，写入输入框原子引用块（`insertQuote`）；不调用模型；设置中有独立 `quoteEnabled` 开关。
- **模型账单开关：** `usageEnabled` 控制输入区 Token 用量入口与右侧栏账单（设置 → 模型上的分账号余额不受影响）。
- **工作区文件编辑：** 官方预览工具栏「编辑」→ Monaco（高亮 / 搜索 / `Ctrl+S` / 停顿自动保存）；默认可回官方预览打开。
- **附加目录：** 右侧指南胶囊挂本地文件夹（样式对齐「工作区文件」），浏览后走官方预览 / 编辑；不扩大 Agent 沙箱。
- **删除会话：** 侧栏会话 ⋯ 永久删除，并清理该会话插件本地数据。

### Changed

- **设置页：** 拆成「功能 / 模型与路由 / 关于」下划线页签；功能按对话增强与工作区与会话分组。
- **规则：** 用户可见能力必须在「功能」页有开关，禁止孤儿功能（见 `AGENTS.md` / `.cursor/rules/no-orphan-features.mdc`）；`MODULES` 现含 9 项。

### Fixed

- 划词引用注册改为局部 `inject(['uiConversation'])`，避免未注入服务抛错拖垮文件编辑 / 附加目录挂载。
- 引用浮钮提高层级并 portal 到 `body`，避免悬停时被预览 / 编辑器文字盖住。

### Docs

- README 中英文同步划词引用、工作区编辑 / 附加目录、会话删除与设置页结构；补截图与 `docs/images/thumbs/` 方裁预览；界面一览「类别 / 说明 / 预览」表点击打开原图。
- README 中英文钉到 `0.3.5`。

## 0.3.4 - 2026-11-06

### Fixed

- **压缩上下文：** 侧栏按钮改为直连官方 `ctx.compaction.compactNow`（与聊天 `/compact` 同路径）；Auto 会话下恢复对 `purpose=compaction` 的 `llm.stream` 哨兵改写，避免「压缩未完成，会话可能未变化」。

### Docs

- README 中英文钉到 `0.3.4`。

## 0.3.3 - 2026-11-06

### Fixed

- **设置写入：** 优化 / 预测 / Auto 档位改为原子 `mutate`；按 Typert 三参签名传数字 `revision`；修订冲突时 `describe` 后重试一次，避免 Desktop 0.2.2「设置未保存，请重试。」
- **设置可用性：** 启动不再硬注入 `remote.settings`（避免拖慢账号页）；设置页按需懒注入；插件未启用时给出明确提示。
- **优化按钮悬停：** Tooltip 改为 `portal` + `side=top`，避免部分会话窗口悬停时整窗抖动。

### Changed

- **0.2.2 兼容：** 模型座次与 turn 边界改走 `agent.model.current()` / `agents.turnBoundaryOf`；Auto 仍以哨兵占座，仅在每步 `prepareCall` 映射到 Instant/Thinking/Pro（不 `select` 掉 Auto）。
- **本地开发安装：** `desktop:link` 改为 pack→解压到 profile 内再 `file:`，避免 Windows Junction 暴露仓库 `node_modules` 导致插件一直「已关闭」；profile 不再二次 `insert` enhancer（由包内 `cordis.patch.yml` 负责）。

### Docs

- README 中英文钉到 `0.3.3`。

## 0.3.2 - 2026-11-05

### Fixed

- **检查点预览：** RPC `request` / `preview` 允许可选 `atSeq`，时间线按检查点打开时不再因 `strictObject` 拒参而直接「恢复未完成」。
- **投影恢复：** 改为 cut-first（先写投影 cut、再恢复已跟踪文件）；维护态下按 Session **id** 判定，避免对象身份抖动误报 `session-changed`；跨轮合并已跟踪文本文件（含已删除路径）并正确还原。
- **Auto 切模：** 为 `agent-enhancer/auto` 哨兵补上 `context.contextWindow`，避免 Desktop `0.2.2` compaction-basic 报 `no context capacity for agent-enhancer/auto` 而无法选中 Auto。

### Changed

- **轮/步分账：** 不再覆写 Host `sessionStats` 的 turns/steps（官方 ActivityPill / 统计页保留完整日志口径）；检查点时间线 lead 改为「当前可见对话」，并注明与底部官方统计可能不一致。
- **检查点入口：** 主路径为消息旁时间线图标与右侧栏；会话统计标题行仅作可选 DOM 捷径（探测失败静默）。

### Docs

- README 中英文钉到 `0.3.2`，并按投影截断 / cut-first 口径更新回退说明。

## 0.3.1 - 2026-11-04

### Changed

- 兼容 **DSH Desktop `0.2.2-rc.1`**：peer/dev 依赖升至 `0.2.2-rc.1`，Cordis `4.1.0`；`engines.dsh` 改为 `>=0.2.2-rc.1 <0.3.0-0`。
- 适配 Cordis 4.1 `internal/update(resolvedConfig, next)`；composer `InputActions.insertQuote`；投影 `stateOf` 的 `unknown` 返回类型与用量 `purpose` 扩展点。

## 0.3.0 - 2026-11-04

### Added

- **模型账单**：会话旁 Token 用量入口；右侧栏汇总输入 / 输出 / 缓存读、热力、功能占比、按模型与调用记录；按官方价估算「约 ¥」（非发票）；支持今天 / 7 天 / 30 天 / 全部。
- **分账号余额**：**设置 → 模型** 中 DeepSeek 账号（Platform 钱包）与 API Key（`/user/balance`）分别显示余额，两位小数，可点击刷新。
- **上下文明细**：占用环与右侧栏明细；系统提示 / 工具 / 消息拆分；一键官方 `/compact`；中英文本地化。
- **Auto 路由**：主会话与优化 / 预测 / 压缩可选 Auto；Instant / Thinking / Pro 档位映射；默认中英双语启发式，可选小模型分类（失败回退启发式）。
- 设置页 **插件更新**：npm 安装可检查并更新；链接安装仅说明；registry 依次尝试 npm / jsDelivr / npmmirror。

### Changed

- README 按「写提示 / 回退 / 用量与成本 / 上下文 / 模型路由」归类功能与截图，中英文同步。

## 0.2.0 - 2026-11-03

### Changed

- **重命名**：包名 `dsh-composer-enhancer` → `dsh-agent-enhancer`；插件 ID `composer-enhancer` → `agent-enhancer`；展示名「Composer 增强 / Composer Enhance」→「智能体增强 / Agent Enhance」。
- 请卸载旧包后再安装新包；检查点目录会从旧 `plugin-data` 路径自动迁移；会话中的旧 rollback/undo 标记仍可识别。
- GitHub 仓库请同步重命名为 `dsh-agent-enhancer`；awesome-dsh-plugin / npm 市场需按新包名更新条目。

## 0.1.6 - 2026-11-03

### Added

- 对话恢复后可通过 Composer **+** / `/` 指令菜单执行 **撤销恢复**（仅存在可撤销 tip 时显示），撤回最近一次恢复标记并还原恢复前的预览内容。
- 支持仅对话或对话 + 已跟踪文件的恢复范围；补充中英文文档与界面截图。

### Fixed

- 撤销恢复含工具调用的回合时补写 `tool/call`，避免会话日志在重新加载时因 V4 格式校验失败（`not-started error requires an object`）。
- 撤销后同步 idle `lastTurn` 并校正客户端 turn 映射，避免紧接着发送的新消息把刚恢复的回复挤掉或折叠。

## 0.1.5 - 2026-10-31

### Fixed

- 区分 npm 与目录链接安装的卸载流程；禁止对链接仓库直接执行 `plugin remove` / `pnpm remove`，并提供经过一次性克隆验证的安全卸载步骤，避免删除源码和 Git 元数据。

## 0.1.4 - 2026-10-31

### Fixed

- 优化与预测的系统提示词明确保持用户到 Agent 的人称视角：优化稿仍是用户请求，预测仅是下一条用户提示词，不颠倒说话者或生成助手回答。
- 历史搜索、预测与提示浮层改为跟随 Composer 内容宽度，在窗口和布局宽窄变化时保持左右对齐，不再使用固定或视口宽度。

## 0.1.3 - 2026-10-31

### Fixed

- 按 DSH 官方依赖模型，将需要与宿主共享实例的 DSH 包和 React 同时声明在 `peerDependencies` 与 `devDependencies`，目录链接安装时优先使用宿主运行时，避免重复 `Session` 类导致模型调用失败。
- 新增运行时依赖清单合同测试，保证 Git 源码、目录开发安装和 npm 发布共用一致的共享依赖声明。
- 补充 npm 发布元数据与目录开发安装文档。

## 0.1.2 - 2026-10-30

### Changed

- 提示词优化按草稿清晰度自适应：模糊草稿补全执行信息，明确草稿保持克制；允许通用执行建议但不虚构硬约束。
- 优化与撤销入口使用官方 ghost 图标按钮，常态透明并保留 hover/focus 反馈。
- 历史搜索优先使用 Alt+R，并在可用环境保留 Ctrl+R 兼容；根因是 Ctrl+R 在到达 DOM 前被 Desktop 拦截。覆盖浮层查询、Enter 采纳不发送、Esc 恢复和卸载清理回归验证。

## 0.1.1 - 2026-10-30

### Changed

- 整稿优化通过稳定引用占位符保留 chips / 引用及顺序，仅改写其他文字；撤销同样恢复原始引用结构。
- 优化与撤销按钮改为原生风格图标，设置页整理为历史、优化、预测三行及独立隐私说明。
- 优化与草稿恢复失败统一使用 `MODEL_UNAVAILABLE`、`MODEL_FAILED`、`INVALID_OUTPUT`、`SESSION_CHANGED`、`ROLLBACK_FAILED` 五种稳定脱敏分类和对应本地化提示。
- 官方 DSH 运行依赖升级到 `0.2.1-rc.5`，兼容范围明确收窄为 `>=0.2.1-rc.5 <0.3.0-0`；真实 rc.3 启动失败，不再声明支持。

### Fixed

- 跨 chip 选区禁止局部优化，保留草稿并提示调整选区或优化整稿，避免破坏引用结构。
- 结构化草稿的优化缓存、编辑失效和撤销增加引用一致性保护。
- 修正 chip 展开文本与官方编辑器 detect 坐标混用，以及写回时重读 DOM 导致的优化/撤销失败。
- 回滚写入失败使用 `ROLLBACK_FAILED` 明确提示并禁用重试，避免部分优化稿被误报为已恢复或可普通重试。

## 0.1.0 - 2026-10-29

### Added

- 当前已加载会话的提示词历史：首末行导航、原草稿与光标往返、Esc 恢复、Ctrl+R 搜索及采纳不发送。
- 整稿或选区提示词优化、撤销、当前会话运行时缓存、编辑失效及异步草稿/会话保护。
- 回复后的单条下一条提示词预测、Tab 填入不发送及过期预测取消。
- 历史、优化、预测三个独立模块开关，以及不自动停用任何插件的第三方共存提示。
- Host 会话事件请求审计；无提示词内容或采纳率遥测。
- Desktop 初始发布包、安装与隐私文档。
