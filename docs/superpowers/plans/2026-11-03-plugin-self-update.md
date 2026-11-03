# 插件自更新实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在设置页提供「检查更新 / 更新到 x.y.z」：对比 npm `latest`，npm 安装且可调 `dsh` 时一键升级，否则展示原因与可复制 CLI。

**架构：** Host 纯模块负责 semver、registry、`installKind`、spawn；`AgentEnhancerService` 暴露 `checkUpdate` / `applyUpdate`（owner 门禁）；设置页注入 remote 调用并驱动状态机。不热重载，成功后提示完全退出重启。

**技术栈：** 现有 Cordis host/client、Typert remote、Vitest、React 设置页、zh/en `locales.ts`、Node `fetch` + `child_process.spawn`。

**规格：** `docs/superpowers/specs/2026-11-03-plugin-self-update-design.md`

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/host/update/types.ts` | `UpdateCheckResult`、`ApplyUpdateResult`、`InstallKind` |
| `src/host/update/semver.ts` | `isNewerVersion(latest, current)` |
| `src/host/update/registry.ts` | `fetchLatestVersion(packageName, opts?)` → npm `dist-tags.latest` |
| `src/host/update/install-kind.ts` | 解析 desktop profile 下本包是否 link/junction |
| `src/host/update/cli.ts` | `probeDsh`、`runPluginAdd`、命令字符串 |
| `src/host/update/check.ts` | 组装 `checkUpdate` / `applyUpdate` 业务（可注入 deps 便于测） |
| `src/host/rpc.ts` + `src/client/remote.ts` | 注册方法与 client invoke |
| `src/host/index.ts` | `AgentEnhancerService.checkUpdate` / `applyUpdate` |
| `src/client/dsh/settings.tsx` | 版本行 UI 状态机 |
| `src/client/index.ts` | 向 `PluginSettings` 注入 update remotes |
| `src/client/locales.ts` | zh/en 文案 |
| `src/client/styles.module.css` | 更新行少量样式（复用 settingRow） |
| `tests/update-*.test.ts` / `tests/components.test.tsx` | 单元 + UI |

---

### 任务 1：semver 与类型

**文件：**
- 创建：`src/host/update/types.ts`
- 创建：`src/host/update/semver.ts`
- 测试：`tests/update-semver.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest'
import { isNewerVersion } from '../src/host/update/semver.ts'

describe('isNewerVersion', () => {
  it('is true only when latest > current', () => {
    expect(isNewerVersion('0.2.1', '0.2.0')).toBe(true)
    expect(isNewerVersion('0.3.0', '0.2.9')).toBe(true)
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false)
    expect(isNewerVersion('0.1.9', '0.2.0')).toBe(false)
  })

  it('treats invalid versions as not newer', () => {
    expect(isNewerVersion('', '0.2.0')).toBe(false)
    expect(isNewerVersion('latest', '0.2.0')).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm exec vitest run tests/update-semver.test.ts`  
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现最少代码**

`types.ts`：

```ts
export type InstallKind = 'npm' | 'link' | 'unknown'

export interface UpdateCheckResult {
  readonly current: string
  readonly latest: string | null
  readonly updateAvailable: boolean
  readonly installKind: InstallKind
  readonly canAutoApply: boolean
  readonly command: string
}

export interface ApplyUpdateResult {
  readonly ok: boolean
  readonly message: string
  readonly command?: string
}
```

`semver.ts`：解析 `major.minor.patch`（忽略前缀 `v`）；任一段非数字则返回 `false`；逐段比较 `latest > current`。

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm exec vitest run tests/update-semver.test.ts`  
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/host/update/types.ts src/host/update/semver.ts tests/update-semver.test.ts
git commit -m "$(cat <<'EOF'
feat(update): add semver compare for plugin self-update

EOF
)"
```

---

### 任务 2：registry、installKind、CLI 纯逻辑

**文件：**
- 创建：`src/host/update/registry.ts`
- 创建：`src/host/update/install-kind.ts`
- 创建：`src/host/update/cli.ts`
- 测试：`tests/update-host.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it, vi } from 'vitest'
import { fetchLatestVersion } from '../src/host/update/registry.ts'
import { detectInstallKind } from '../src/host/update/install-kind.ts'
import { pluginAddCommand, resolveCanAutoApply } from '../src/host/update/cli.ts'
import { PACKAGE_NAME } from '../src/identity.ts'
import { mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('fetchLatestVersion', () => {
  it('reads dist-tags.latest from registry json', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      'dist-tags': { latest: '0.2.1' },
    }), { status: 200 }))
    await expect(fetchLatestVersion(PACKAGE_NAME, {
      fetch: fetchImpl,
      currentVersion: '0.2.0',
      timeoutMs: 1000,
    })).resolves.toBe('0.2.1')
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('returns null on non-ok or missing tag', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(fetchLatestVersion(PACKAGE_NAME, {
      fetch: fetchImpl,
      currentVersion: '0.2.0',
      timeoutMs: 1000,
    })).resolves.toBeNull()
  })
})

describe('detectInstallKind', () => {
  it('detects symlink as link and plain dir as npm', () => {
    const root = join(tmpdir(), `dsh-update-kind-${Date.now()}`)
    const nm = join(root, 'node_modules', PACKAGE_NAME)
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    mkdirSync(join(root, 'real-pkg'), { recursive: true })
    writeFileSync(join(root, 'real-pkg', 'package.json'), '{}')
    try {
      symlinkSync(join(root, 'real-pkg'), nm, 'junction')
      expect(detectInstallKind(root)).toBe('link')
      rmSync(nm, { force: true, recursive: true })
      mkdirSync(nm, { recursive: true })
      writeFileSync(join(nm, 'package.json'), '{}')
      expect(detectInstallKind(root)).toBe('npm')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('returns unknown when package folder missing', () => {
    expect(detectInstallKind(join(tmpdir(), 'no-such-profile-xyz'))).toBe('unknown')
  })
})

describe('cli helpers', () => {
  it('builds pinned add command', () => {
    expect(pluginAddCommand('0.2.1')).toBe(
      `dsh plugin --profile desktop add ${PACKAGE_NAME}@0.2.1`,
    )
  })

  it('allows auto apply only for npm + dsh available', () => {
    expect(resolveCanAutoApply({ installKind: 'npm', dshAvailable: true })).toBe(true)
    expect(resolveCanAutoApply({ installKind: 'npm', dshAvailable: false })).toBe(false)
    expect(resolveCanAutoApply({ installKind: 'link', dshAvailable: true })).toBe(false)
    expect(resolveCanAutoApply({ installKind: 'unknown', dshAvailable: true })).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm exec vitest run tests/update-host.test.ts`  
预期：FAIL

- [ ] **步骤 3：实现最少代码**

`registry.ts`：`https://registry.npmjs.org/${encodeURIComponent(name)}`，`AbortSignal.timeout(timeoutMs)`（或等价），`User-Agent: dsh-agent-enhancer/${currentVersion}`，解析 `dist-tags.latest` 字符串。

`install-kind.ts`：`detectInstallKind(profileDir)` → `lstat` `join(profileDir, 'node_modules', PACKAGE_NAME)`；`isSymbolicLink()` → `'link'`；存在目录 → `'npm'`；否则 `'unknown'`。Windows junction 在 Node 上通常表现为 symlink。

`cli.ts`：
- `pluginAddCommand(latest: string): string`
- `resolveCanAutoApply({ installKind, dshAvailable })`
- `probeDsh(run?: SpawnLike): Promise<boolean>` — 短超时跑 `dsh --version`（win32 可先试 `dsh.cmd`）
- `runPluginAdd(latest, run?: SpawnLike): Promise<{ ok: boolean; detail: string }>` — 跑 `pluginAddCommand` 拆成 argv：`['plugin', '--profile', 'desktop', 'add', `${PACKAGE_NAME}@${latest}`]`

将 `spawn` 做成可注入，便于任务 3 mock。

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm exec vitest run tests/update-host.test.ts`  
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/host/update/registry.ts src/host/update/install-kind.ts src/host/update/cli.ts tests/update-host.test.ts
git commit -m "$(cat <<'EOF'
feat(update): add registry, install kind, and dsh cli helpers

EOF
)"
```

---

### 任务 3：check / apply 编排

**文件：**
- 创建：`src/host/update/check.ts`
- 修改测试：`tests/update-host.test.ts`（追加编排用例）

- [ ] **步骤 1：编写失败的测试**

```ts
import { checkPluginUpdate, applyPluginUpdate } from '../src/host/update/check.ts'
import { PACKAGE_VERSION } from '../src/identity.ts'

describe('checkPluginUpdate', () => {
  it('marks update available and canAutoApply for npm + dsh', async () => {
    const result = await checkPluginUpdate({
      currentVersion: '0.2.0',
      fetchLatest: async () => '0.2.1',
      detectKind: () => 'npm',
      dshAvailable: async () => true,
      profileDir: '/fake',
    })
    expect(result).toEqual({
      current: '0.2.0',
      latest: '0.2.1',
      updateAvailable: true,
      installKind: 'npm',
      canAutoApply: true,
      command: `dsh plugin --profile desktop add dsh-agent-enhancer@0.2.1`,
    })
  })

  it('disables auto apply for link even when newer', async () => {
    const result = await checkPluginUpdate({
      currentVersion: '0.2.0',
      fetchLatest: async () => '0.3.0',
      detectKind: () => 'link',
      dshAvailable: async () => true,
      profileDir: '/fake',
    })
    expect(result.canAutoApply).toBe(false)
    expect(result.updateAvailable).toBe(true)
  })
})

describe('applyPluginUpdate', () => {
  it('does not spawn when canAutoApply is false', async () => {
    const run = vi.fn()
    const result = await applyPluginUpdate({
      check: {
        current: '0.2.0',
        latest: '0.2.1',
        updateAvailable: true,
        installKind: 'link',
        canAutoApply: false,
        command: 'dsh plugin --profile desktop add dsh-agent-enhancer@0.2.1',
      },
      runAdd: run,
      messages: {
        linkBlocked: 'dev-link',
        success: 'ok-restart',
        failed: 'failed',
        noUpdate: 'none',
      },
    })
    expect(run).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.message).toBe('dev-link')
    expect(result.command).toContain('dsh-agent-enhancer@0.2.1')
  })

  it('spawns and reports success', async () => {
    const run = vi.fn(async () => ({ ok: true, detail: '' }))
    const result = await applyPluginUpdate({
      check: {
        current: '0.2.0',
        latest: '0.2.1',
        updateAvailable: true,
        installKind: 'npm',
        canAutoApply: true,
        command: 'dsh plugin --profile desktop add dsh-agent-enhancer@0.2.1',
      },
      runAdd: run,
      messages: {
        linkBlocked: 'dev-link',
        success: 'ok-restart',
        failed: 'failed',
        noUpdate: 'none',
      },
    })
    expect(run).toHaveBeenCalledWith('0.2.1')
    expect(result).toEqual({ ok: true, message: 'ok-restart' })
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm exec vitest run tests/update-host.test.ts`  
预期：FAIL（`check.ts` 不存在）

- [ ] **步骤 3：实现 `check.ts`**

- `resolveDesktopProfileDir(env = process.env, home = homedir())`：`join(env.DSH_HOME ?? join(home, '.dsh'), 'profiles', 'desktop')`
- `checkPluginUpdate(deps)`：拉 latest → semver → kind → probe → 组装 `UpdateCheckResult`；`latest === null` 时 `updateAvailable: false`，`command` 用 `@latest` 或仍用 current（规格：钉版本；无 latest 时用 `dsh-agent-enhancer@latest`）
- `applyPluginUpdate`：无 `latest` 或 `!updateAvailable` → `{ ok: false, message: noUpdate, command }`；`!canAutoApply` → 按 `installKind` 选 message（link 用 `linkBlocked`，其它用 `failed` 或单独 `manualOnly`——实现时 `messages` 含 `manualOnly`）；可升则 `runAdd(latest)`

默认导出包装函数供 Host 调用时传入真实 deps。

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm exec vitest run tests/update-host.test.ts tests/update-semver.test.ts`  
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/host/update/check.ts tests/update-host.test.ts
git commit -m "$(cat <<'EOF'
feat(update): orchestrate checkUpdate and applyUpdate

EOF
)"
```

---

### 任务 4：Host RPC + client remote

**文件：**
- 修改：`src/host/rpc.ts` — 增加 schema 与 `agentEnhancer/checkUpdate`、`agentEnhancer/applyUpdate`
- 修改：`src/host/index.ts` — `AgentEnhancerService` 两方法（`assertOwner`）
- 修改：`src/client/remote.ts` — descriptors + `agentEnhancerCheckUpdate` / `agentEnhancerApplyUpdate` invoke
- 测试：`tests/client-remote.test.ts`（若已有模式则追加）或 `tests/update-rpc.test.ts` 仅测 schema 导出形状

- [ ] **步骤 1：编写 / 扩展失败测试**

在 `tests/update-rpc.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { remoteInfo } from '../src/host/rpc.ts'
import { clientRemoteInfo } from '../src/client/remote.ts'

describe('update remotes', () => {
  it('registers checkUpdate and applyUpdate on host and client', () => {
    const hostMethods = remoteInfo.descriptors.map(d => d.method)
    expect(hostMethods).toEqual(expect.arrayContaining(['checkUpdate', 'applyUpdate']))
    const clientMethods = clientRemoteInfo.descriptors.map(d => d.method)
    expect(clientMethods).toEqual(expect.arrayContaining(['checkUpdate', 'applyUpdate']))
  })
})
```

（若 `remoteInfo` 无 `.descriptors`，改用与现有 `listCatalog` 测试相同的导出字段；client 侧已有 `clientRemoteInfo.descriptors`。）

- [ ] **步骤 2：运行确认失败或缺口**

运行：`pnpm exec vitest run tests/update-rpc.test.ts`  
预期：FAIL 或不含新方法

- [ ] **步骤 3：接线实现**

Zod：

```ts
const updateCheckResultSchema = z.strictObject({
  current: z.string(),
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  installKind: z.enum(['npm', 'link', 'unknown']),
  canAutoApply: z.boolean(),
  command: z.string(),
})
const applyUpdateResultSchema = z.strictObject({
  ok: z.boolean(),
  message: z.string(),
  command: z.string().optional(),
})
```

`AgentEnhancerService`：

```ts
async checkUpdate(): Promise<UpdateCheckResult> {
  this.assertOwner()
  return checkPluginUpdate({ /* 默认 deps：fetchLatestVersion, detectInstallKind(profileDir), probeDsh, PACKAGE_VERSION */ })
}

async applyUpdate(): Promise<ApplyUpdateResult> {
  this.assertOwner()
  const check = await checkPluginUpdate({ /* same */ })
  return applyPluginUpdate({
    check,
    runAdd: latest => runPluginAdd(latest),
    messages: {
      // Host 返回稳定英文 key 或已本地化短句：规格要求用户可见走 client locale。
      // 约定：message 为稳定 code，client 再 t() —— 或 Host 返回英文、client 忽略用自己的状态文案。
      // 本计划采用：ApplyUpdateResult.message 为稳定 code：
      // 'restart' | 'link' | 'manual' | 'failed' | 'none'
      linkBlocked: 'link',
      success: 'restart',
      failed: 'failed',
      noUpdate: 'none',
      manualOnly: 'manual',
    },
  })
}
```

**Message codes（钉死，client 映射 locale）：** `restart` | `link` | `manual` | `failed` | `none`

Client invoke 模式抄 `agentEnhancerCompactContext`（`RemoteResult`、失败抛 `AuxiliaryError` 或专用，检查失败可用 `MODEL_FAILED` 以外的码——若不愿扩 errors，检查失败让 `latest: null` 由 UI 处理，RPC 本身仍 `ok`）。

`checkUpdate` / `applyUpdate`：**成功路径 RPC result.ok=true**；仅 forbidden / 未预期异常走 RemoteError。

- [ ] **步骤 4：测试通过 + typecheck 片段**

运行：`pnpm exec vitest run tests/update-rpc.test.ts tests/update-host.test.ts`  
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/host/rpc.ts src/host/index.ts src/client/remote.ts tests/update-rpc.test.ts
git commit -m "$(cat <<'EOF'
feat(update): expose checkUpdate and applyUpdate remotes

EOF
)"
```

---

### 任务 5：locales + 设置 UI

**文件：**
- 修改：`src/client/locales.ts` — 扩展 `LocaleNamespaceMap` 与 zh/en
- 修改：`src/client/dsh/settings.tsx` — 更新区块；props 增加 `checkUpdate` / `applyUpdate`
- 修改：`src/client/index.ts` — 注入 remote
- 修改：`src/client/styles.module.css` — `.settingsUpdate` 等（host token）
- 修改：`tests/components.test.tsx` — harness 与用例
- 修改：`tests/settings-race.test.tsx` — 若 props 必填则补 stub

**文案 key（钉死）：**

| key | zh | en |
| --- | --- | --- |
| `updateTitle` | 插件更新 | Plugin update |
| `updateCurrent` | 当前版本 v{version} | Current version v{version} |
| `updateCheck` | 检查更新 | Check for updates |
| `updateChecking` | 正在检查… | Checking… |
| `updateLatest` | 已是最新版本 | You're up to date |
| `updateAvailable` | 发现 v{version} | Update available: v{version} |
| `updateApply` | 更新到 v{version} | Update to v{version} |
| `updateApplying` | 正在更新… | Updating… |
| `updateRestart` | 已更新，请完全退出并重启 Desktop | Updated. Fully quit and restart Desktop. |
| `updateLinkBlocked` | 当前为开发目录链接，请在本地执行 pnpm build，勿用 npm 覆盖。 | This install is a linked dev folder. Run pnpm build locally; do not overwrite via npm. |
| `updateManual` | 无法自动更新，请退出 Desktop 后运行： | Cannot update automatically. Quit Desktop, then run: |
| `updateFailed` | 更新失败。请退出 Desktop 后运行： | Update failed. Quit Desktop, then run: |
| `updateCheckFailed` | 检查更新失败，请稍后重试。 | Could not check for updates. Try again later. |
| `updateCopy` | 复制命令 | Copy command |
| `updateCopied` | 已复制 | Copied |

- [ ] **步骤 1：编写失败的 UI 测试**

在 `components.test.tsx` 的 `settingsHarness` 增加可选 `checkUpdate` / `applyUpdate`；默认 mock：

```ts
checkUpdate: vi.fn(async () => ({
  current: '0.2.0',
  latest: '0.2.0',
  updateAvailable: false,
  installKind: 'npm' as const,
  canAutoApply: true,
  command: 'dsh plugin --profile desktop add dsh-agent-enhancer@0.2.0',
})),
```

新用例：

```ts
it('auto-checks on mount and shows update action when newer', async () => {
  const checkUpdate = vi.fn(async () => ({
    current: '0.2.0',
    latest: '0.2.1',
    updateAvailable: true,
    installKind: 'npm' as const,
    canAutoApply: true,
    command: 'dsh plugin --profile desktop add dsh-agent-enhancer@0.2.1',
  }))
  const applyUpdate = vi.fn(async () => ({ ok: true, message: 'restart' as const }))
  settingsHarness(undefined, { checkUpdate, applyUpdate, translations: { /* 含 update* en */ } })
  expect(await screen.findByText(/Update available: v0\.2\.1/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Update to v0\.2\.1/ }))
  await waitFor(() => expect(applyUpdate).toHaveBeenCalled())
  expect(await screen.findByText(/Fully quit and restart Desktop/)).toBeTruthy()
})

it('shows copyable command when auto apply is blocked', async () => {
  const checkUpdate = vi.fn(async () => ({
    current: '0.2.0',
    latest: '0.2.1',
    updateAvailable: true,
    installKind: 'link' as const,
    canAutoApply: false,
    command: 'dsh plugin --profile desktop add dsh-agent-enhancer@0.2.1',
  }))
  settingsHarness(undefined, { checkUpdate, applyUpdate: vi.fn() })
  expect(await screen.findByText(/linked dev folder/i)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy()
})
```

（按现有 harness 签名调整；`translations` 补全 update keys。）

- [ ] **步骤 2：运行确认失败**

运行：`pnpm exec vitest run tests/components.test.tsx -t "auto-checks on mount"`  
预期：FAIL

- [ ] **步骤 3：实现 UI + locales + 注入**

状态机：`idle | checking | upToDate | available | applying | success | blocked | checkError | applyError`  
- mount：`useEffect` 调 `checkUpdate`（有 prop 时）  
- `available` + `canAutoApply` → 显示 Apply；否则 `blocked`（link 文案 / manual）  
- Apply 成功 `message==='restart'` → success；失败 → applyError + command + Copy  
- Copy：`navigator.clipboard.writeText(command)`，短暂显示 `updateCopied`

样式：复用 `.settingRow`；命令用等宽/`settingDescription`；按钮复用 `.settingsConfigure` 或主操作略强调（仍用 `--dsw-*`，无新色板）。

`PluginSettingsProps`：

```ts
readonly checkUpdate?: () => Promise<UpdateCheckResult>
readonly applyUpdate?: () => Promise<ApplyUpdateResult>
```

无 prop 时不渲染更新行（测试旧用例仍过）——**或**始终渲染但检查按钮 no-op。规格要求有入口：生产路径必须注入。约定：**有 `checkUpdate` 才渲染更新区块**。

`client/index.ts`：

```ts
const checkUpdate = () => agentEnhancerCheckUpdate.invoke(ctx.remote)
const applyUpdate = () => agentEnhancerApplyUpdate.invoke(ctx.remote)
// SettingsTab 传入
```

- [ ] **步骤 4：运行相关测试**

运行：`pnpm exec vitest run tests/components.test.tsx tests/settings-race.test.tsx tests/update-semver.test.ts tests/update-host.test.ts tests/update-rpc.test.ts`  
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/client/locales.ts src/client/dsh/settings.tsx src/client/index.ts src/client/styles.module.css tests/components.test.tsx tests/settings-race.test.tsx
git commit -m "$(cat <<'EOF'
feat(update): add settings update row with check and apply

EOF
)"
```

---

### 任务 6：全量校验与 CHANGELOG

**文件：**
- 修改：`CHANGELOG.md` — 在 Unreleased / 下一版节记一条「设置页支持检查并更新插件」
- 可选：`README.md` 设置表加一行「插件更新」

- [ ] **步骤 1：跑全量检查**

运行：`pnpm check`  
预期：typecheck + test + build + verify-package 全绿

- [ ] **步骤 2：补 CHANGELOG（中英若项目只维中文则只中文）**

- [ ] **步骤 3：Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "$(cat <<'EOF'
docs: note plugin self-update in changelog

EOF
)"
```

- [ ] **步骤 4：对照规格验收清单心检**

1. npm + 有新版本 → 显示更新按钮  
2. 已最新 → 文案正确  
3. link → 不 spawn  
4. 失败 → 命令 + 复制  
5. `pnpm check` 绿  

---

## 规格覆盖自检

| 规格项 | 任务 |
| --- | --- |
| 设置页版本行与状态 | 任务 5 |
| 进页自动检查 + 手动再查 | 任务 5 |
| npm latest + semver | 任务 1–3 |
| installKind link/npm/unknown | 任务 2–3 |
| canAutoApply + spawn add@version | 任务 2–4 |
| 失败/引导 + 复制命令 | 任务 5 |
| owner 门禁 RPC | 任务 4 |
| 不热重载、提示重启 | 任务 3–5（`restart` code） |
| Vitest 覆盖 | 任务 1–5 |
| zh/en locales | 任务 5 |

无占位符任务；`ApplyUpdateResult.message` 稳定 code 与 locale 映射在任务 4/5 钉死一致。
