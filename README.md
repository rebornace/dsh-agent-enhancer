# DSH Composer Enhancer

为 DeepSeek Harness Desktop Composer 提供历史提示词、提示词优化和下一条提示词预测。三个模块默认开启，可在插件设置中独立关闭。

## 兼容环境

- DSH：仅支持 `>=0.2.1-rc.5 <0.3.0-0`；`0.2.1-rc.3` 已实测无法加载，不受支持。
- Windows：DeepSeek Harness Desktop `0.2.1-rc.5`，Windows 10 22H2（build 19045）。
- macOS：**未验证**，不声明支持。

## 安装

退出所有 Desktop 窗口和托盘进程，确认旧主进程结束后再安装/启动；不要只重新启动启动器。

直接从 npm 安装，无需下载 tgz 或构建源码：

```sh
dsh plugin --profile desktop add dsh-composer-enhancer@0.1.5
```

npm registry 安装已通过真实模型优化验证。不要使用 `web` profile 代替 Desktop 安装或验收。安装并启动 Desktop 后，Composer 右侧会出现优化入口，插件设置中会出现“Composer 增强”。

## 目录开发安装

在仓库根目录的 PowerShell 中执行：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build
$PluginDir = (Resolve-Path .).Path
dsh plugin --profile desktop add $PluginDir
```

需要与宿主共享实例的 DSH 包同时声明在 `peerDependencies` 和 `devDependencies`：目录链接时运行中使用宿主副本，类型检查和测试使用开发副本。不要把这些包移入 `dependencies`，否则会产生重复运行时并导致 `Session` 类型错误。目录安装已通过真实模型优化验证。

## 三项操作

### 历史提示词

- 在同一会话发送过提示词后，草稿首行按 `↑` 逐条回看，末行按 `↓` 返回；返回时恢复原草稿和原光标。
- 多行草稿中间按 `↑` / `↓` 仍执行普通光标移动。
- `Esc` 恢复原草稿；`Alt+R` 搜索当前会话已发送的提示词（可用环境兼容 `Ctrl+R`），`Enter` 只采纳到草稿，不发送。
- 历史仅覆盖当前已加载会话中的消息，不读取其他会话。含 chips / 引用的结构化草稿受保护，不会因历史操作变成纯文本。

### 提示词优化

- 模糊草稿补全执行信息，明确草稿保持克制；允许通用执行建议但不虚构硬约束。
- 点击“优化提示词”直接替换整稿；有选区时只优化选区，选区之外保持不变。
- 含 chips / 引用时，整稿优化只改写其他文字并保留引用及顺序；撤销会恢复原始引用结构。跨 chip 选区受保护，不会写稿，并提示优化整稿或调整选区。
- 优化后按钮变为“撤销优化”，可还原原稿；未编辑时再优化复用当前会话的运行时缓存，编辑后才会发起新请求。
- 请求期间继续输入、切换会话或开始新回合会使迟到结果失效。普通失败保留原稿，可手动重试但不自动重试；回滚失败显示专用错误并禁止重试，需手动恢复。界面按五种稳定脱敏错误分类显示提示，不暴露提供商原始错误。

### 下一条提示词预测

- 回复完成后最多显示一条灰字建议；`Tab` 只填入草稿，不发送。
- 输入、切换会话、开始新回合或关闭预测模块会清除旧预测；失败静默且不自动重试。

## 隐私、审计与缓存

- 历史功能不请求模型。优化会把原稿或选区及近期上下文发送给当前模型提供商；预测会发送近期完成的对话内容。
- 优化缓存只保存当前会话的运行时状态，不写入磁盘，不跨会话复用。
- `optimize` / `predict` 的精确请求写入当前会话的 `plugin:composer-enhancer/request` 可忽略审计事件，不增加聊天消息卡片；卸载后官方阅读器可安全跳过这些事件。
- 插件不采集或上传提示词内容、采纳率等遥测数据。模型请求仍受当前模型提供商的隐私策略约束。

## 共存与开关

检测到第三方同类插件时只显示可忽略的提示，本模块保持默认开启，不会自动停用、隐藏或修改第三方插件。需要独占某种行为时，请在“Composer 增强”设置中手动关闭对应模块；重新开启即可恢复。

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
