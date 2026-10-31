# DSH Composer Enhancer

为 DeepSeek Harness Desktop Composer 提供历史提示词、提示词优化和下一条提示词预测。三个模块默认开启，可在插件设置中独立关闭。插件由 Desktop 宿主加载，没有独立进程或 Web 入口。

## 兼容环境

- DSH：仅支持 `>=0.2.1-rc.5 <0.3.0-0`；`0.2.1-rc.3` 已实测无法加载，不受支持。
- Windows：DeepSeek Harness Desktop `0.2.1-rc.5`，Windows 10 22H2（build 19045）。
- macOS：**未验证**，不声明支持。
- 源码开发另需：Node.js `^22.19.0 || >=24.0.0`、pnpm `11.28.5`（通过 Corepack 调用），以及 Desktop 自带的 `dsh` CLI。

## 安装

安装、升级或卸载前，退出所有 Desktop 窗口和托盘进程，确认旧主进程结束后再操作；不要只重新启动启动器。

直接从 npm 安装，无需下载 tgz 或构建源码：

```sh
dsh plugin --profile desktop add dsh-composer-enhancer@0.1.5
```

npm registry 安装已通过真实模型优化验证。不要使用 `web` profile 代替 Desktop 安装或验收。安装完成后启动 Desktop：Composer 右侧会出现优化入口，插件设置中会出现“Composer 增强”。如果 Desktop 已在运行，请完全退出后重新启动再检查。

## 目录开发安装

在仓库根目录的 PowerShell 中执行：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build
$PluginDir = (Resolve-Path .).Path
dsh plugin --profile desktop add $PluginDir
```

安装后完全退出并重新启动 Desktop。之后修改源码需重新执行 `corepack pnpm build`，再让 Desktop 重新加载插件；Desktop 加载的是 `lib/` 中的构建产物，仓库没有独立 dev server。

需要与宿主共享实例的 DSH 包同时声明在 `peerDependencies` 和 `devDependencies`：目录链接时运行中使用宿主副本，类型检查和测试使用开发副本。不要把这些包移入 `dependencies`，否则会产生重复运行时并导致 `Session` 类型错误。目录安装已通过真实模型优化验证。

## 配置

三个模块开关位于 Desktop 设置中的插件页，标签为“Composer 增强”。默认全部开启，修改后立即生效，并写入 Host 设置文档（重启后保留）。

| 开关 | 配置键 | 默认 | 作用 |
| --- | --- | --- | --- |
| 历史提示词 | `historyEnabled` | 开启 | Composer 内的历史回看与搜索 |
| 提示词优化 | `optimizeEnabled` | 开启 | 优化按钮、选区/整稿优化与撤销 |
| 下一条提示词预测 | `predictEnabled` | 开启 | 回复后的单条下一条提示词建议 |

关闭模块会停用对应入口或快捷键，并取消进行中的优化/预测请求；再次开启即可恢复。通常只需使用设置页，不需要手工编辑 profile 配置文件。

## 三项操作

典型流程：先发送一条提示词并等待回复完成；清空草稿后按 `↑` 回看历史，或按 `Alt+R` 搜索；输入新草稿后点击右侧优化按钮；发送并收到下一条回复后，按 `Tab` 采纳预测。

下图同时标出优化入口与预测建议的位置：

![提示词优化入口与下一条提示词预测](docs/images/optimize-and-predict.png)

*优化入口位于 Composer 右侧；预测建议在回复后显示，按 `Tab` 采纳。*

### 历史提示词

- 在同一会话发送过提示词后，草稿首行按 `↑` 逐条回看，末行按 `↓` 返回；返回时恢复原草稿和原光标。
- 多行草稿中间按 `↑` / `↓` 仍执行普通光标移动。
- `Esc` 恢复原草稿；`Alt+R` 搜索当前会话已发送的提示词（可用环境兼容 `Ctrl+R`），搜索框内用 `↑` / `↓` 选择结果，`Enter` 或点击只采纳到草稿，不发送。
- 历史仅覆盖当前已加载会话中的消息，不读取其他会话。含 chips / 引用的结构化草稿不响应 `↑` / `↓` 和历史搜索快捷键（`Alt+R`，兼容环境为 `Ctrl+R`），避免历史替换破坏引用结构。

历史搜索界面：

![历史提示词搜索界面](docs/images/prompt-history.png)

*`Alt+R` 打开历史搜索；`↑` / `↓` 选择结果，`Enter` 或点击采纳到草稿。*

### 提示词优化

- 模糊草稿补全执行信息，明确草稿保持克制；允许通用执行建议但不虚构硬约束。
- 点击“优化提示词”直接替换整稿；有选区时只优化选区，选区之外保持不变。请求进行中按钮显示忙碌状态并禁用。
- 含 chips / 引用时，整稿优化只改写其他文字并保留引用及顺序；撤销会恢复原始引用结构。选区跨 chip 时不会写稿，并提示优化整稿或调整选区。
- 优化后按钮变为“撤销优化”，可还原原稿；未编辑时按 `Esc` 也可撤销。撤销后若草稿未改动，再次优化会复用当前会话的运行时缓存，不发起新请求；修改草稿后才会重新请求。
- 请求期间继续输入、切换会话或开始新回合会使迟到结果失效。普通失败保留原稿，可手动重试但不自动重试；回滚失败显示专用错误并禁止重试，需手动恢复。界面按 `MODEL_UNAVAILABLE`、`MODEL_FAILED`、`INVALID_OUTPUT`、`SESSION_CHANGED`、`ROLLBACK_FAILED` 五类脱敏错误显示本地化提示，不暴露提供商原始错误。

### 下一条提示词预测

- 回复完成后，在草稿为空且会话空闲时最多显示一条灰字建议；按 `Tab` 只填入草稿，不发送。
- 同一会话同一轮次最多请求并展示一次。输入、切换会话、开始新回合或关闭预测模块会清除旧预测；失败静默且不自动重试。

## 隐私、审计与缓存

- 历史功能不请求模型。优化会把原稿或选区及最近一轮已完成对话发送给当前模型提供商；预测会发送最近一轮已完成对话内容。
- 优化缓存只保存当前会话的运行时状态，不写入磁盘，不跨会话复用。
- `optimize` / `predict` 的精确请求（系统提示词和消息内容）会写入当前会话的 `plugin:composer-enhancer/request` 可忽略审计事件，不增加聊天消息卡片；卸载后官方阅读器可安全跳过这些事件。
- 插件不采集或上传提示词内容、采纳率等遥测数据；上述审计事件仅保存在本地会话中，仍包含请求内容。模型请求仍受当前模型提供商的隐私策略约束。

## 共存与开关

已启用插件清单中出现已知同类插件时，只显示可忽略的提示；本模块保持默认开启，不会自动停用、隐藏或修改第三方插件。提示按模块显示并可关闭。

需要独占某种行为时，请在“Composer 增强”设置中手动关闭对应模块；重新开启即可恢复。

未来若官方提供重叠模块，先在 `CHANGELOG.md` 中标记本插件对应能力弃用，再在后续版本中移除，不做静默行为切换。

## 卸载

### npm 安装

仅当插件通过 npm registry 安装时，执行：

```sh
dsh plugin --profile desktop remove dsh-composer-enhancer
```

此流程已在隔离 profile 验证，会移除 profile 内的包和 bundle 条目。**不要把它用于下面的目录链接安装。**

### 目录开发安装

> [!WARNING]
> 对目录链接安装，禁止执行 `dsh plugin --profile desktop remove dsh-composer-enhancer`，也不要在 profile 中执行等效的 `pnpm remove`。DSH `0.2.1-rc.5` 下该操作会沿目录链接删除源仓库的 `node_modules` 和部分 `.git` 元数据。`dsh plugin ... unlink` 也已验证只会输出 `Nothing to unlink`，不能移除链接或 bundle 条目。

退出所有 Desktop 窗口和托盘进程，确认旧主进程结束后再操作：

1. 编辑 **DSH profile 目录**中的 `package.json`，不要编辑源仓库的同名文件。从 `dependencies` 删除 `dsh-composer-enhancer`，并从 `dsh.profile.bundles` 数组删除同一项；保留 `@deepseek-ai/dsh-base` 和其他插件。
2. 在 PowerShell 中定位 profile，并运行 `install` 更新 lockfile。未设置 `DSH_HOME` 时，默认目录为 `$HOME/.dsh`：

   ```powershell
   $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
   $ProfileDir = Join-Path $DshHome 'profiles\desktop'
   dsh plugin --profile desktop install
   ```

3. `install` 可能留下目录链接。在同一 PowerShell 中执行以下 Guard 流程，只删除 profile 中的 Junction / SymbolicLink 本身，不递归删除其目标：

   ```powershell
   $PluginLink = Join-Path $ProfileDir 'node_modules\dsh-composer-enhancer'
   $Item = Get-Item -LiteralPath $PluginLink -Force -ErrorAction SilentlyContinue
   if ($null -ne $Item) {
     if ($Item.LinkType -notin @('SymbolicLink', 'Junction')) {
       throw "拒绝删除非链接路径：$PluginLink"
     }
     $Item.Delete()
   }
   Test-Path -LiteralPath $PluginLink # 应为 False
   ```

4. 在源仓库根目录确认源码、Git 元数据和依赖仍然存在：

   ```powershell
   git status --short
   git fsck --full --no-dangling
   Test-Path -Path .git, package.json, node_modules # 应均为 True
   ```

重载 Desktop 后，增强入口、监听和请求随之移除，官方 Composer 的菜单、IME、草稿持久化与发送行为保持由官方实现。

## 开发与测试

以下命令均在仓库根目录执行：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck   # TypeScript 类型检查
corepack pnpm test        # Vitest；globalSetup 会先执行一次构建
corepack pnpm build       # 生成 lib/，供 Desktop 加载
corepack pnpm check       # typecheck + test + build + 打包校验，生成 dist/*.tgz
```

`check` 的打包校验由 `scripts/verify-package.mjs` 完成，依赖 pnpm 环境（读取 `npm_execpath`）和系统 `tar`；请通过 `corepack pnpm check` 运行，不要直接执行该脚本。

仓库没有自动化 Desktop E2E。需要真实 Desktop 验收时，可用隔离环境启动宿主：

```powershell
node scripts/smoke-desktop.mjs `
  --executable "C:\Path\To\DeepSeek Harness.exe" `
  --root "$env:TEMP\dsh-composer-enhancer-smoke"
```

脚本会创建隔离的 `DSH_HOME`、`user-data-dir` 和 workspace，并开启 CDP（默认 `9333`）。`--root` 需为新目录；复用已有目录时加 `--reuse`。启动后按 `<root>\steps.md` 先安装待测包，再逐项手动验收。

## 项目结构

```text
.
├─ src/
│  ├─ config.ts              # 三个模块的默认开关与设置解析
│  ├─ errors.ts              # 五种稳定错误码
│  ├─ host/                  # Host 侧：模型调用、RPC、引用占位、审计事件
│  └─ client/
│     ├─ composer/           # 历史、优化、预测的状态机与协调器
│     ├─ dsh/                # DSH 槽位组件、编辑器桥、设置页与提示
│     ├─ locales.ts          # 中英文文案
│     ├─ remote.ts           # 客户端 RPC 描述与调用
│     └─ index.ts            # 客户端插件入口
├─ tests/                    # Vitest 单元、组件、组装与打包合同测试
├─ scripts/
│  ├─ css-modules-plugin.mjs # 构建期 CSS Modules 处理
│  ├─ verify-package.mjs     # 打包内容与共享运行时校验
│  └─ smoke-desktop.mjs      # 隔离 Desktop 验收环境
├─ docs/images/              # README 截图
├─ lib/                      # 构建产物（git 忽略，Desktop 实际加载）
├─ dist/                     # pnpm check 生成的 tgz（git 忽略）
├─ cordis.patch.yml          # DSH bundle 注入声明
├─ esbuild.config.mjs        # Host/Client 打包与类型声明生成
├─ vitest.config.ts
├─ tsconfig.json
├─ tsconfig.build.json
├─ pnpm-workspace.yaml
└─ package.json
```

发布包的业务文件只包含 `lib/` 与 `cordis.patch.yml`（另含 npm 必带的 `package.json`、README 等清单文件），不包含 `src/`、`tests/` 或脚本。
