# Auto 模型路由实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在模型列表增加 `Auto` 选项（固定模型保留）；按 ChatGPT 心智内部路由到 Instant / Thinking / Pro；可选小模型分类开关（默认关）；主会话每轮重路由；插件辅助共用同一 Router。

**架构：** Agent 层纯函数 `AutoRouter` 定档 + 查映射表；`AuxiliaryModels.route` 与主会话发车前钩子在识别哨兵 `provider=agent-enhancer / model=auto` 后解析为真实路由；分类器失败静默回退启发式。

**技术栈：** 现有 Cordis host/client、`src/host/model.ts`、`src/config.ts`、Vitest、zh/en `locales.ts`。

**规格：** `docs/superpowers/specs/2026-11-03-auto-model-routing-design.md`

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/host/auto-route/types.ts` | `AutoTier`、`AutoRouteMap`、哨兵常量、`TurnRouteContext` |
| `src/host/auto-route/heuristic.ts` | 纯启发式定档 |
| `src/host/auto-route/classifier.ts` | 解析分类器输出；发起分类调用的薄封装接口 |
| `src/host/auto-route/router.ts` | `resolveAutoRoute(...)`：开关 → 分类/启发式 → 映射 → 降级 |
| `src/host/auto-route/sentinel.ts` | `isAutoSelection` / `AUTO_SELECTION` |
| `src/config.ts` | Auto 映射字段、`autoClassifierEnabled`、哨兵识别与 follow 区分 |
| `src/host/index.ts` `Config` | 同步 volatile 配置字段 |
| `src/host/model.ts` | `route()` 识别 Auto，走 Router |
| `src/host/auto-route/session-hook.ts` | 主会话每轮：Auto 哨兵 → 解析 → 当次调用路由 |
| `src/client/dsh/settings.tsx` | 药丸增加 Auto；分类开关；三档+分类器映射（可折叠高级区） |
| `src/client/locales.ts` | zh/en 文案 |
| `tests/auto-route-*.test.ts` | 启发式、Router、哨兵、model.route 集成 |

---

### 任务 1：哨兵与启发式定档（纯函数）

**文件：**
- 创建：`src/host/auto-route/types.ts`
- 创建：`src/host/auto-route/sentinel.ts`
- 创建：`src/host/auto-route/heuristic.ts`
- 测试：`tests/auto-route-heuristic.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest'
import { AUTO_PROVIDER, AUTO_MODEL, isAutoSelection } from '../src/host/auto-route/sentinel.ts'
import { pickTierHeuristic } from '../src/host/auto-route/heuristic.ts'

describe('auto sentinel', () => {
  it('detects auto selection', () => {
    expect(isAutoSelection({ provider: AUTO_PROVIDER, model: AUTO_MODEL })).toBe(true)
    expect(isAutoSelection({ provider: '', model: '' })).toBe(false)
    expect(isAutoSelection({ provider: 'deepseek', model: 'deepseek-chat' })).toBe(false)
  })
})

describe('pickTierHeuristic', () => {
  it('maps short plain prompts to instant', () => {
    expect(pickTierHeuristic({ text: 'hi', feature: 'predict' })).toBe('instant')
  })
  it('maps compact feature toward thinking', () => {
    expect(pickTierHeuristic({ text: '', feature: 'compact' })).toBe('thinking')
  })
  it('maps long + depth cues to pro', () => {
    expect(pickTierHeuristic({
      text: '请深入分析并仔细推理以下长文：' + 'x'.repeat(800),
      feature: 'optimize',
    })).toBe('pro')
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm exec vitest run tests/auto-route-heuristic.test.ts`  
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现最少代码**

`types.ts`：

```ts
export type AutoTier = 'instant' | 'thinking' | 'pro'

export interface AutoTierRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string
}

export interface AutoRouteMap {
  readonly instant: AutoTierRoute
  readonly thinking: AutoTierRoute
  readonly pro: AutoTierRoute
  readonly classifier: AutoTierRoute
}

export interface HeuristicInput {
  readonly text: string
  readonly feature?: 'optimize' | 'predict' | 'compact' | 'session'
  readonly toolHeavy?: boolean
}
```

`sentinel.ts`：`AUTO_PROVIDER = 'agent-enhancer'`，`AUTO_MODEL = 'auto'`，`isAutoSelection({provider,model})`。

`heuristic.ts`：`DEPTH_RE = /深入|仔细|分析|plan|reason|thorough/i`；长度阈值：`<80` 短、`>=80 && <400` 中、`>=400` 长；`compact`→thinking；`predict` 且短→instant；长+DEPTH→pro；`toolHeavy`→至少 thinking。

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm exec vitest run tests/auto-route-heuristic.test.ts`  
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/host/auto-route/types.ts src/host/auto-route/sentinel.ts src/host/auto-route/heuristic.ts tests/auto-route-heuristic.test.ts
git commit -m "feat: add Auto tier heuristic and selection sentinel"
```

---

### 任务 2：Router 映射与降级

**文件：**
- 创建：`src/host/auto-route/router.ts`
- 测试：`tests/auto-route-router.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it, vi } from 'vitest'
import { resolveAutoRoute } from '../src/host/auto-route/router.ts'

const map = {
  instant: { provider: 'p', model: 'flash', reasoningEffort: '' },
  thinking: { provider: 'p', model: 'chat', reasoningEffort: '' },
  pro: { provider: 'p', model: 'reasoner', reasoningEffort: 'high' },
  classifier: { provider: 'p', model: 'flash', reasoningEffort: '' },
}

describe('resolveAutoRoute', () => {
  it('uses heuristic when classifier disabled', async () => {
    const route = await resolveAutoRoute({
      text: 'hi',
      feature: 'predict',
      map,
      classifierEnabled: false,
      isAvailable: () => true,
    })
    expect(route).toEqual({ provider: 'p', model: 'flash', reasoningEffort: '', tier: 'instant' })
  })

  it('falls back when mapped model unavailable', async () => {
    const route = await resolveAutoRoute({
      text: 'hi',
      feature: 'predict',
      map,
      classifierEnabled: false,
      isAvailable: (p, m) => m !== 'flash',
    })
    expect(route.model).toBe('chat')
  })

  it('uses classifier tier when enabled', async () => {
    const classify = vi.fn(async () => 'pro' as const)
    const route = await resolveAutoRoute({
      text: 'x',
      feature: 'session',
      map,
      classifierEnabled: true,
      classify,
      isAvailable: () => true,
    })
    expect(classify).toHaveBeenCalledOnce()
    expect(route.tier).toBe('pro')
    expect(route.model).toBe('reasoner')
  })

  it('falls back to heuristic when classify throws', async () => {
    const route = await resolveAutoRoute({
      text: 'hi',
      feature: 'predict',
      map,
      classifierEnabled: true,
      classify: async () => { throw new Error('boom') },
      isAvailable: () => true,
    })
    expect(route.tier).toBe('instant')
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm exec vitest run tests/auto-route-router.test.ts`  
预期：FAIL

- [ ] **步骤 3：实现 `resolveAutoRoute`**

签名：

```ts
export async function resolveAutoRoute(options: {
  readonly text: string
  readonly feature?: HeuristicInput['feature']
  readonly toolHeavy?: boolean
  readonly map: AutoRouteMap
  readonly classifierEnabled: boolean
  readonly classify?: (text: string, signal?: AbortSignal) => Promise<AutoTier>
  readonly isAvailable: (provider: string, model: string) => boolean
  readonly signal?: AbortSignal
  readonly fallback?: AutoTierRoute
}): Promise<AutoTierRoute & { tier: AutoTier }>
```

逻辑：定档 → 按 `pro → thinking → instant` 降级找第一个 `isAvailable` → 再不行用 `fallback` 或 `map.thinking`。

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm exec vitest run tests/auto-route-router.test.ts`  
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/host/auto-route/router.ts tests/auto-route-router.test.ts
git commit -m "feat: resolve Auto routes with classifier hook and fallbacks"
```

---

### 任务 3：配置字段与 `isAuto` / follow 区分

**文件：**
- 修改：`src/config.ts`
- 修改：`src/host/index.ts`（`Config` zod 字段）
- 修改：`tests/settings.test.ts`、`tests/host-remote.test.ts`（默认键集合）

- [ ] **步骤 1：编写/扩展失败断言**

在 `tests/settings.test.ts` 增加：默认 `autoClassifierEnabled === false`；`isAutoModel({provider:'agent-enhancer',model:'auto'}) === true`；follow 仍仅 `provider/model` 为空。

- [ ] **步骤 2：运行相关测试确认新断言失败**

运行：`pnpm exec vitest run tests/settings.test.ts`  
预期：FAIL

- [ ] **步骤 3：扩展配置**

`EnhancerSettings` 增加：

```ts
autoClassifierEnabled: boolean
autoInstantProvider / autoInstantModel / autoInstantReasoningEffort
autoThinkingProvider / autoThinkingModel / autoThinkingReasoningEffort
autoProProvider / autoProModel / autoProReasoningEffort
autoClassifierProvider / autoClassifierModel / autoClassifierReasoningEffort
```

默认：`autoClassifierEnabled: false`；各映射 provider/model 默认 `''`（表示「尚未配置，Router 用 agentDefaultModel / 会话模型作 fallback」）。

```ts
export function isAutoModel(selection: Pick<AuxiliaryModelSettings, 'provider' | 'model'>): boolean {
  return selection.provider === AUTO_PROVIDER && selection.model === AUTO_MODEL
}

export function autoRouteMapOf(settings: EnhancerSettings): AutoRouteMap { /* 组装四段 */ }
```

`isFollowSessionModel`：**保持**仅空字符串；Auto 不是 follow。

Host `Config` 增加对应 `z.boolean().default(false).volatile()` 与 `z.string().default('').volatile()`。

- [ ] **步骤 4：跑测试通过并 Commit**

```bash
git add src/config.ts src/host/index.ts tests/settings.test.ts tests/host-remote.test.ts
git commit -m "feat: add Auto route mapping settings and classifier toggle"
```

---

### 任务 4：接入 `AuxiliaryModels.route`

**文件：**
- 修改：`src/host/model.ts`
- 测试：`tests/host-model.test.ts`（或新建 `tests/auto-route-auxiliary.test.ts`）

- [ ] **步骤 1：写失败测试**

当 settings 中 optimize 为 Auto 哨兵、classifier 关、instant 映射到 `p/flash` 时，`generate(optimize…)` 的 `prepareCall` 收到 `{provider:'p', model:'flash'}`（mock `ctx.llm.prepareCall`）。

- [ ] **步骤 2：运行确认失败**

- [ ] **步骤 3：改 `private route`**

```ts
if (isAutoModel(override)) {
  const mapped = await resolveAutoRoute({
    text: /* optimize source or '' for predict */,
    feature: feature,
    map: autoRouteMapOf(this.settings()),
    classifierEnabled: this.settings().autoClassifierEnabled,
    classify: undefined, // 任务 5 再接真调用
    isAvailable: (provider, model) => this.modelExists(provider, model),
    fallback: fromSessionOrDefault(session),
  })
  return { provider: mapped.provider, model: mapped.model, preferredEffort: mapped.reasoningEffort }
}
if (!isFollowSessionModel(override)) { /* 现状 */ }
// follow：若会话选择为 Auto，则 resolveAutoRoute feature:'session'；否则现状
```

注意：`route` 今日为同步；改为 `async route` 并更新 `execute` 中的 `await this.route(...)`。

`modelExists`：第一版可对「映射非空」返回 true，空映射视为不可用；后续可接 catalog。

- [ ] **步骤 4：测试通过并 Commit**

```bash
git commit -m "feat: route auxiliary Auto selections through AutoRouter"
```

---

### 任务 5：分类器调用

**文件：**
- 创建：`src/host/auto-route/classifier.ts`
- 修改：`src/host/model.ts`（传入 `classify`）
- 测试：`tests/auto-route-classifier.test.ts`

- [ ] **步骤 1：测试 `parseClassifierTier`**

接受 `instant`/`thinking`/`pro`（大小写、前后空白、被 JSON 包裹时取词）；其它返回 `undefined`。

- [ ] **步骤 2：实现 parse + `createClassifier`**

`createClassifier(llm, map.classifier)` 返回 `async (text, signal) => AutoTier`：`prepareCall` + 短 system「只输出 instant|thinking|pro」+ `maxTokens: 8` + 子 timeout（如 4s AbortController）；解析失败 throw，由 Router 回退。

- [ ] **步骤 3：在 `AuxiliaryModels` 当 `autoClassifierEnabled` 时注入 `classify`**

- [ ] **步骤 4：Commit**

```bash
git commit -m "feat: optional small-model Auto tier classifier"
```

---

### 任务 6：设置 UI + 文案

**文件：**
- 修改：`src/client/dsh/settings.tsx`
- 修改：`src/client/locales.ts`
- 修改：`tests/components.test.tsx` / `tests/settings-race.test.tsx`（若断言键集合）

- [ ] **步骤 1：locales 增加键**

`modelAuto`、`autoClassifier`、`autoClassifierDescription`、`autoMappingTitle`、`autoTier_instant`、`autoTier_thinking`、`autoTier_pro`、`autoTier_classifier`（zh/en）。

- [ ] **步骤 2：药丸选项**

在 follow / 固定模型之外增加 Auto：`encodeAutoSelection()` → 写入哨兵 provider/model；展示 `t('modelAuto')`。

分类开关：`autoClassifierEnabled` 布尔行（放在模型区附近）。

高级区（可简单折叠或紧随其后）：四个模型药丸绑定 instant/thinking/pro/classifier 映射（复用现有 `ModelPill` 模式，但 **禁止** 再选 Auto/follow，仅真实模型）。

- [ ] **步骤 3：手动点选路径的单测或组件测**（至少 encode/decode Auto）

- [ ] **步骤 4：Commit**

```bash
git commit -m "feat: expose Auto and classifier controls in settings UI"
```

---

### 任务 7：主会话每轮重路由

**文件：**
- 创建：`src/host/auto-route/session-hook.ts`
- 修改：`src/host/index.ts` `apply()` 安装 hook
- 修改：client 侧使官方选择器可选 Auto（见步骤 1–2）
- 测试：`tests/auto-route-session.test.ts`

- [ ] **步骤 1：确认官方选择器注入点**

阅读并采用其一（实现时写进代码注释）：

1. Client：在加载 catalog 后 **prepend** 合成条目 `{ provider: AUTO_PROVIDER, model: AUTO_MODEL, name: t('modelAuto') }` 到插件可控的目录视图；若官方 `/model` 用 Host catalog，则在 host `buildAuxiliaryModelCatalog` **之外** 找 `session.modelCatalog` 合并点，或注册 `conversation.input.model.label` 仅改标签不够——必须能 `select({provider,model})` 持久化为哨兵。
2. 若无法改官方 catalog：在插件设置增加「会话使用 Auto」总开关，写入会话级或插件态，hook 仍按「逻辑 Auto」每轮解析（产品次优，规格允许过渡）。

优先实现路径 1；卡住时落地路径 2 并在 PR 说明。

- [ ] **步骤 2：Host session hook**

在 `apply()`：

```ts
installAutoSessionRoute(ctx, {
  settings: () => resolveSettings(...),
  // 从 agent.options 或 session projection 读选择；若 isAutoModel 则 resolveAutoRoute
  // 将当次真实路由交给 llm：优先包装 ctx.llm.prepareCall
})
```

`installAutoSessionRoute` 行为：

- `inject` 已有 `llm`：保存 `const inner = ctx.llm.prepareCall.bind(ctx.llm)`，替换为包装函数：若当前 agent/session 选择为 Auto，则 `resolveAutoRoute` 后用映射 route 调用 `inner`；否则原样。
- **每轮重路由**：不缓存跨 turn 的 tier；可在单次 `prepareCall` 生命周期内用 WeakMap 防重入。
- 分类器与辅助共用同一 settings。

- [ ] **步骤 3：测试包装：mock llm.prepareCall，两次不同 text → 不同 tier（启发式）**

- [ ] **步骤 4：Commit**

```bash
git commit -m "feat: re-route Auto session model on every turn"
```

---

### 任务 8：压缩路径与回归

**文件：**
- 修改：`src/host/context-compact.ts` / `src/host/index.ts` `compactRoute()`：若 compact 设置为 Auto，先 `resolveAutoRoute({feature:'compact',...})` 再写入临时 options（与现覆盖一致）
- 运行：`pnpm check`（或至少 `pnpm typecheck && pnpm test && pnpm build`）

- [ ] **步骤 1：compact Auto 单测**（mock commands.execute，断言临时 options 为映射模型）

- [ ] **步骤 2：全量测试**

- [ ] **步骤 3：更新规格状态为「已批准 / 实现中→完成」一行 CHANGELOG**

- [ ] **步骤 4：Commit**

```bash
git commit -m "feat: honor Auto mapping on compact and verify full suite"
```

---

## 规格覆盖自检

| 规格项 | 任务 |
|---|---|
| Auto 列表项 + 固定模型保留 | 3、6、7 |
| Instant/Thinking/Pro | 1、2、3 |
| Pro 第一版 | 1–3 |
| 分类开关默认关 | 3、5、6 |
| 每轮重路由 | 7 |
| 插件辅助 | 4、5、8 |
| 降级 / 失败回退 | 2、5 |
| Agent 层非网关 | 全文 |
| zh/en | 6 |

## 占位符扫描

无 TODO/待定步骤；任务 7 含两条显式实现路径（优先 / 过渡），非空描述。
