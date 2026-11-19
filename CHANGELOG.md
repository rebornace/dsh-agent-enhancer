# Changelog

## Unreleased

### Added

- **浏览器 Agent · 演示录制支持多标签：** 录制不再只跟随会话绑定的那个标签，专用浏览器里**所有已打开的标签**以及录制期间新开的标签都会被记录，每个步骤带上它发生在哪个标签（`[tab N]`）与该标签的地址，重放时用 `browser_list_tabs` + `browser_follow_tab` 按标签切换。侧栏步骤、复制与「发给智能体」同样带标签信息。
- **浏览器 Agent · 录制角标：** 录制期间每个被录的标签右下角显示「演示录制中 / 完成后回到 Desktop 结束录制」（跟随页面语言），结束后自动消失；角标不拦截点击、不进无障碍树，也不受站点 CSP 影响。
- **浏览器 Agent · 演示一键重放：** `browser_demonstrate` 新增 `replay: true`：你说「我做一遍，然后你来」时，录完立刻由浏览器驱动按 role+name 自己跑一遍，不用先等模型读步骤。跑到不能如实复现的步骤（密码等被掩码的字段、`<select>`、找不到的控件）就停下，报告停在哪一步、还剩哪些，绝不假装跑完。
- **浏览器 Agent · SPA 路由也入步骤：** 单页应用用 `pushState` / `replaceState` / `popstate` / hash 换路由时不再漏记，录制里会多出一条 `navigate ->` 步骤（URL 里的 token 参数照旧脱敏）。

### Fixed

- **浏览器批准弹窗看不清：** 弹窗背景写成 `var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-primary))`，而这两个名字主题里都不存在，整条 `background` 被浏览器丢弃，于是弹窗透明地盖在网页上、文字互相叠。现改为官方卡片配方（`--dsw-alias-bg-layer-1` + `--dsw-alias-border-l2` 发丝边 + `--dsw-shadow-lv3` + `--dsw-radius-md`），亮/暗主题都不透明。
- **客户端样式里的无效设计 token：** 同一类问题在别处还有 23 个不存在的 token 名（`--dsw-alias-text-primary`、`--dsw-alias-border-primary`、`--dsw-font-sm-14`、`--dsw-radius-s` 等），对应声明全部静默失效（边框、字号、圆角因此丢过）。已全部换成主题真实 token，并加 `tests/client-design-tokens.test.ts`：CSS 里出现主题未定义的 token 即失败。

## 0.3.16 - 2026-11-19

### Added

- **浏览器 Agent · 演示录制：** 新增 `browser_demonstrate`（设置 → 功能 → 浏览器 Agent → **演示录制**，默认关）。两个入口：右侧栏浏览器面板的「开始演示 / 结束并查看步骤」，或智能体在对话里发起（走人工卡片，普通说「我演示给你看」即可）。记录点击 / 填写 / 回车 / 跳转，密码 / OTP / token 字段只记 `***`。步骤实时经 `exposeBinding` 回到 Host，页面跳转不会丢；点进输入框再输入不会多出多余步骤。
- **浏览器 Agent · 步骤回填：** 录完后面板提供「复制步骤」与「发给智能体」——后者把步骤作为引用插入当前会话输入框，确认发送即可让模型按步骤重放，不用手动复制粘贴。
- **浏览器 Agent · 录制状态：** 侧栏实时显示「正在录制演示」；智能体发起时指向人工卡片，用户自己发起时给出「结束并查看步骤」。

## 0.3.15 - 2026-11-18

### Fixed

- **浏览器 Agent · 调试采集：** 关掉「调试与页面模拟」开关会真正停止采集并丢弃缓冲（原先只是拒绝工具调用，监听器仍在写入）；采集改读当前缓冲，重新打开不会重复挂载。
- **浏览器 Agent · 采集范围：** `browser_network` / `browser_console` 默认只读会话绑定标签，多标签调试不再混页；`allTabs: true` 读全量，被过滤的条数会在回复里说明。
- **浏览器 Agent · 快照顺序：** 控件（按钮 / 输入框）排在链接前面，链接密集页不会再读成「全是链接」。

### Changed

- **宿主依赖对齐 Desktop `0.2.2-rc.5`：** `devDependencies` 钉 `0.2.2-rc.5`（构建与测试基准），`peerDependencies` 放宽为 `>=0.2.2-rc.2 <0.3.0-0`，于是还停在 rc.2 的 Desktop 也能加载。rc.2→rc.5 的源码改动只落在官方内部包（`ui-sidebar` 新增 `sidebar.session.action`、`ui-workspace` 新增 `workspace.picker`、`ui-primitives` 新增图标、`dsh-web` 增加 `llmProvider` 选项、`dsh-llm` 增加 `CONTENT_REFUSED` 错误码），对我们用到的槽位与类型均为新增。
- **浏览器 Agent · 闲置标签：** 关闭时间由固定 10 分钟改为可选 **10 / 30 / 60 分钟 / 不自动关闭**；0.3.14 的布尔配置自动映射（`true` → 10 分钟，`false` → 不自动关闭）。
- **浏览器 Agent · 开关命名：** 「调试工具」改为「**调试与页面模拟**」，说明里写清它同时管网络/控制台读取与深色模式、视口模拟。

## 0.3.14 - 2026-11-18

### Added

- **浏览器 Agent · 调试工具：** `browser_network` / `browser_console` / `browser_emulate`，由设置 → 功能 → 浏览器 Agent → **调试工具**（`browserAgentDebugTools`，默认关）统一开关。只记 URL / 状态码 / 耗时 / 失败原因 / console 文本与位置，**不读请求头、Cookie、响应体**；URL 中疑似密钥的 query（`token` / `code` / `sig` / `session` 等）与 console 文本里的 URL 一律替换为 `***`；环形缓冲 300 条，驱动销毁即清空。
- **浏览器 Agent · 只读标签：** 侧栏标签行新增「只读」按钮（`browserAgentSetTabReadOnly`）。开启后 `browser_click` / `browser_type` / 同标签 `browser_navigate` 直接以 `tab_read_only` 失败并不再弹批准框，读工具、滚动、`newTab: true` 不受限。
- **浏览器 Agent · 闲置标签回收：** 设置 → **自动关闭闲置标签**（`browserAgentIdleClose`，默认开）。约 10 分钟未使用的标签自动关闭；会话绑定标签、当前页、最后一个标签永不关闭；关闭时同步解绑会话并丢弃该会话记忆。
- **浏览器 Agent · 诊断：** `browser_status` 与侧栏给出 `diagnosis` + `next:`（功能未开 / 未启动 / WebKit 引擎缺失 / 本机无可用浏览器 / profile 被占用 / 其它启动失败），可用性探针每会话只探一次，不随侧栏轮询 spawn `where` / `which`。
- **浏览器 Agent · 快照自检行：** `browser_snapshot` 回显 `emulation:`（当前模拟状态）与 `harvest:`（页面侧可交互元素 / 控件 / 锚点计数）。

### Fixed

- **浏览器 Agent · 标签与 ref：** tabId 由 `TabRegistry` 单调分配、关闭不回收；ref 全局唯一，驱动与会话层均按 tab 存。切走再切回原标签可直接点击、无需重拍快照；用别的标签的 ref 会指名所属标签（`ref 9 belongs to tab 2`），不再有静默点中同号元素的风险；关闭标签或删除会话时对应记忆一并丢弃。
- **浏览器 Agent · 人工介入卡片：** `browser_ask_user` 的普通请求（关标签、开开关…）不再套用「登录 / 验证码 / 二次验证」文案，改为只显示该请求本身与「已完成，继续」；登录墙仍用原登录文案。
- **浏览器 Agent · console 脱敏：** 修复只给 network 打码、console 文本明文泄露 token 的问题（Chrome 的 `Failed to load resource` 会把请求 URL 写进消息）。
- **浏览器 Agent · 快照预算：** 链接密集页不再把搜索框 / 按钮挤出 80 条预算；proximity 补 href 的控件不再被当作链接排序。
- **启动开销：** `playwright-core` 改为按需动态加载，插件入口导入 609 ms → 213 ms（功能关闭的用户不再付这笔钱）。

### Changed

- **浏览器 Agent · 状态文案：** `browser_status` 清掉 MV3 时代的 `bridge:` / `extension:` 说法，改为 `browser:` / `driver:`。

### Docs

- README 中英文钉 `0.3.14`。

## 0.3.13 - 2026-11-14

### Removed

- **插件自更新：** 去掉「关于」页检查/应用更新（`checkUpdate` / `applyUpdate`、`src/host/update`）。改用官方 Desktop 插件更新。

### Fixed

- **网页聊天 · 他人分享导入：** 公开分享常用 `message_id` / `parent_id`（未必有裸 `id`）；补齐解析，并对孤儿 parent / 重复 id 回退线性导入，避免「解析预览正常、转到工作区报对话无效」。
- **网页聊天 · wire：** `ImportWebChatHistory` / `ResolveWebChatShareLink` 的 transcript schema 补上 `messages` / `currentMessageId`，修复富 fragments 触发的 boundary validation 失败。
- **网页聊天 · 当前对话：** guest 拉取 `history_messages` 时带上 `localStorage.userToken` Bearer（仅 cookie 不够）；失败时不再静默回退 DOM 抓取（否则无思考过程），并引导改用分享链接。
- **网页聊天 · 客户端解析：** `share-link` 校验改用 `TextEncoder` 计字节，修复浏览器侧 `Buffer is not defined`（导入当前对话在 client 解析 history）。

### Changed

- **网页聊天 · 单段保真：** 分享链接 / `history_messages` 的 fragments（思考、联网搜索、打开网页、阅读链接）按官方 `dsh-deepseek-chat-import` 映射写入 Session 种子；预览仍只显示提问/回答正文。公开 `share/content` **可以**含 `THINK`，但以该次 payload 为准；全量 `deepseek_data-*.zip` 继续让位官方实验插件。架构说明见 `docs/architecture/web-chat-bridge.md`。
- **网页聊天 · 文案：** 选择器与「导入当前对话」对齐为「导入分享链接」+「导入」；明确支持任意账号公开分享。

### Docs

- README 中英文钉到 `0.3.13`。

## 0.3.12 - 2026-11-12

### Added

- **浏览器 Agent · 多标签：** `browser_navigate({ newTab: true })`；右侧栏标签列表切换（`browserAgentSelectTab`）。
- **连接器（MCP）：** 列表/详情显示运行状态；详情「重启连接」「探测」（官方 `connectionStatusOf` / `probeServer`）；已连通时探测读现活实例，避免 ModelScope 等过期 URL 二次握手误报。

### Fixed

- **浏览器 Agent：** 工具结果 `tabId` 跟随当前页（不再写死 `1`）；缺 Playwright WebKit 时侧栏提示可复制的 `npx playwright install webkit`；登录墙面板改为 `alertdialog` 并聚焦「我已完成」。
- **划词引用：** 不再挂对话正文双入口（让位官方聊天引用）；开关仅控制预览 / 编辑器 / 终端。
- **暂停后续：** 去掉原生 `title`，只保留产品 Tooltip，避免悬停双提示；文案与官方 Stop 区分。
- **Auto 未配置：** 即时 / 思考 / 专业均未设置或不可用时，不再落到空模型再报模糊失败；会话 `prepareCall`、优化 / 建议下一条、上下文压缩（含跟随会话 + Auto）统一抛出 `AUTO_ROUTE_UNCONFIGURED`，并提示到 **设置 → 智能体增强 → 模型与路由** 配置档位。
- **Auto 档位回退：** 首选档模型不可用时，继续尝试其它已映射档（如 Instant→flash 挂了仍可用 Thinking），而不是直接报未配置。
- **网页聊天 → 工作区：** 导入前若工作区目录缺失则自动 `mkdir`（与官方建会话一致）；仅当路径不可建/不是目录时才报 `missing-cwd`。聊天写入会话日志，不往工作区文件夹落文件，空目录属正常。
- **网页聊天 · 当前对话样式：** 「当前对话」优先走登录态 `history_messages`（与分享链接同套 fragments Markdown）；失败时 DOM 抓取改为 HTML→Markdown，不再把整段回答压成一行纯文本。
- **连接器反馈：** 探测/重启等结果改用浮动 Toast，不再顶开整页布局。
- **发布校验（Windows）：** `scripts/verify-package.mjs` 在 `npm_execpath` 为 `pnpm.exe` 时直接执行，不再 `node pnpm.exe`（Node 会报未知扩展名）。

### Changed

- **DSH Desktop `0.2.2-rc.2`：** peer/dev `@deepseek-ai/dsh-*` 升至 `0.2.2-rc.2`；`engines.dsh` 改为 `>=0.2.2-rc.2 <0.3.0-0`。
- **网页聊天导入：** 受保护 system head / assistant 步改为 `session.append([...])` 批量追加；seed 录制器同步支持单事件与批量 overload。
- **划词引用浮层：** `placeQuoteChip` 按官方 Menu 口径，在 WebKit 下把视觉原点 client 坐标换算到 layout 原点，避免缩放/平移后 `position: fixed` 错位。
- **Auto 哨兵：** `LlmError` 代码改为内置 `UNSUPPORTED_OPTION`（官方已移除自定义 `AUTO_SENTINEL`）。
- **测试夹具：** `SessionSnapshot` 补齐 `historyWasPartial` / `historyLoadStatus`（聊天上滑自动加载历史相关字段）。
- **浏览器 Agent：** 不做官方侧栏 URL 镜像 / 窗口置顶按钮（沙箱与登录态不共用，实用价值低）。

### Docs

- README 中英文钉到 `0.3.12`。

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
