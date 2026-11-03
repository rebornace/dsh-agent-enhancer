# 插件自更新设计

日期：2026-11-03  
状态：已批准（2026-11-03）  
范围：设置页「检查更新 / 更新到 x.y.z」，Host 查 npm + 条件执行 `dsh plugin add`

## 目标

让已安装本插件的用户在 **设置 → 内置插件 → 智能体增强** 内完成「检查是否有新版本 → 有则一键升级」；无法自动升级时给出可复制的 CLI 命令，而不是静默失败。

## 非目标

- 后台自动升级、静默重启 Desktop
- 改造官方「设置 → 插件」页或依赖 `dsh-market`
- 从 GitHub / 私有源 / 非 `latest` 通道升级
- 卸载、降级、跨 major 的破坏性迁移向导
- 对 `link:` 开发安装执行 npm 覆盖安装

## 方案

采用 **能升则升，失败再引导（方案 C）**：

1. 对比当前 `PACKAGE_VERSION` 与 npm `dist-tags.latest`
2. 安装类型为 npm 且本机可调用 `dsh` 时，Host 执行升级命令
3. `link:` / 无 CLI / 执行失败时，展示原因与可复制命令

## 用户可见行为

入口：设置首页，隐私说明上方单独一行（版本 + 操作）。

| 状态 | 展示 |
| --- | --- |
| 初始 | 当前版本（如 `v0.2.0`）+「检查更新」 |
| 检查中 | 按钮 disabled，「正在检查…」 |
| 已最新 | 「已是最新版本」；仍可再点「检查更新」 |
| 有更新 | 「发现 vX.Y.Z」+ 主按钮「更新到 vX.Y.Z」 |
| 升级中 | 「正在更新…」disabled |
| 升级成功 | 「已更新，请完全退出并重启 Desktop」 |
| 不可自动升 | 说明原因（开发链接 / 未找到 CLI 等）+ 命令文本 +「复制」按钮（`clipboard.writeText`） |
| 失败 | 短错误文案 + 命令文本 +「复制」；不影响其它设置项 |

检查策略：进入设置页自动检查一次；之后仅手动「检查更新」。

文案：`zh` / `en` 全部走 `agent-enhancer` locales。

## 架构

```text
设置 UI (client)
  │  checkUpdate / applyUpdate
  ▼
agentEnhancer RPC (host, owner 门禁)
  ├─ registry：GET https://registry.npmjs.org/dsh-agent-enhancer
  ├─ installKind：解析 profile node_modules 中本包是否为 link/junction
  └─ apply：spawn `dsh plugin --profile desktop add dsh-agent-enhancer@<latest>`
```

- 当前版本以构建期写入的 `PACKAGE_VERSION`（`src/identity.ts`）为准，不在运行时再读本地 `package.json` 作为权威源（避免与发布包不一致）。
- 只认 npm 包名 `dsh-agent-enhancer` 的 `dist-tags.latest`；用 semver 比较 `latest > current` 才算有更新。
- Profile 固定为 `desktop`（与 README 安装说明一致）；不探测 / 不写入 `web`。

## RPC 合同

服务：现有 `agentEnhancer`（`TypertRemoteService`），与其它方法一样要求 `owner` 门禁。

### `checkUpdate()`

返回：

```ts
{
  current: string           // 如 "0.2.0"
  latest: string | null     // 查不到则为 null
  updateAvailable: boolean
  installKind: 'npm' | 'link' | 'unknown'
  canAutoApply: boolean     // npm 且判定可调用 dsh 时为 true；link/unknown 为 false
  command: string           // 始终给出推荐 CLI，便于引导与失败回退
}
```

### `applyUpdate()`

- 若 `canAutoApply === false`：不 spawn，返回 `{ ok: false, message, command }`
- 若可自动升：执行  
  `dsh plugin --profile desktop add dsh-agent-enhancer@<latest>`  
  Windows 需兼顾 `dsh.cmd`；设超时；非 0 退出或超时 → `{ ok: false, message, command }`
- 成功：`{ ok: true, message }`（文案要求用户完全退出并重启）；**不**在进程内热重载插件

Client 侧对应 remote 描述符与现有 `listCatalog` 等并列注册。

## 安装类型与 canAutoApply

1. 定位 profile 下 `node_modules/dsh-agent-enhancer`（`DSH_HOME` 或默认 `~/.dsh` + `profiles/desktop`）
2. 若为 symbolic link / junction → `installKind = 'link'`，`canAutoApply = false`，引导本地 `pnpm build`
3. 否则 → `installKind = 'npm'`；再以短超时执行 `dsh --version`（Windows 尝试 `dsh.cmd`）判定 CLI 可用；失败则 `canAutoApply = false`
4. 路径无法解析 → `installKind = 'unknown'`，`canAutoApply = false`

Registry 请求：Host 使用运行时 `fetch`，超时约 10s；User-Agent 带上包名与当前版本。

推荐命令模板（钉版本，避免用户再解析 latest）：

```text
dsh plugin --profile desktop add dsh-agent-enhancer@<latest>
```

## 错误处理

| 情况 | 行为 |
| --- | --- |
| registry 超时 / 非 JSON / 无 dist-tags | 检查失败短文案；保留「检查更新」 |
| `dsh` 不在 PATH | 不可自动升 + 命令 |
| spawn 非 0 / 超时 | 升级失败 + 命令 |
| UI 渲染异常 | 现有 SettingsErrorBoundary；更新区块自身错误不拖垮整页 |

不向用户展示堆栈；Host 可 `console.error` 留本地排查。

## 测试

Vitest：

- semver：`updateAvailable` 仅在 `latest > current` 为真（相等 / 更旧为假）
- `link` → `canAutoApply === false`；`npm` + 可调 dsh → `true`
- `applyUpdate` 在 `canAutoApply === false` 时不调用 spawn
- 设置 UI（mock RPC）：检查中 / 已最新 / 有更新 / 失败引导文案与按钮状态

不做：真实打 npm registry、真实改本机 desktop profile 的端到端（可用 mock `fetch` / `spawn`）。

## 文件触点（实现时）

| 区域 | 预期 |
| --- | --- |
| `src/host/` | 新模块（registry + installKind + apply）+ `AgentEnhancerService` 方法 + `rpc.ts` / client remote |
| `src/client/dsh/settings.tsx` | 版本行与状态机 |
| `src/client/locales.ts` | zh / en 文案 |
| `src/client/styles.module.css` | 复用 `settingRow` / 按钮样式；必要时少量补充 |
| `tests/` | 上述单元与 UI 测试 |

## 验收

1. npm 安装且有新版本：设置页显示「更新到 vX.Y.Z」，点后成功并提示重启
2. 已最新：显示「已是最新版本」
3. `link:` 安装：不自动升，说明为开发链接并给出本地构建指引
4. 无 `dsh` / 升级失败：可见错误 + 可复制命令
5. `pnpm check` 通过
