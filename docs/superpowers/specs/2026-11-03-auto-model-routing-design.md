# Auto 模型路由设计

日期：2026-11-03  
状态：已批准（2026-11-03）· **实现完成（2026-11-03）**  
范围：主会话模型选择 + 本插件辅助能力（优化 / 预测 / 压缩）

## 目标

在**不取消「用户钉死固定模型」**的前提下，于模型列表中增加一个 **`Auto`（自动）** 选项。选中后由 Agent 层按 ChatGPT 熟悉的档位做智能路由；未选中时行为与现状完全一致。

## 非目标

- 不在 LLM 网关做黑盒厂商 `auto`
- 不把 Instant / Thinking / Pro 做成与 Auto 并列的主选择项（降低学习成本）
- 不替换或禁用官方 / 第三方已有模型选择
- 第一版不做跨会话的「路由效果」遥测上报（可本地调试日志）

## 用户可见行为

### 模型列表

| 选项 | 行为 |
|---|---|
| 具体模型（现状） | 始终使用该 `provider + model`（+ 可选 reasoning） |
| **Auto / 自动** | 每次需要发车前解析为真实模型；UI 仍显示 Auto |

出现位置：

1. **主会话**：官方模型选择器（与固定模型并列）
2. **插件设置**：优化 / 预测 / 压缩各自的模型药丸（在「跟随会话」之外增加 Auto；或与跟随会话、固定模型并列——实现时与现有药丸交互保持清晰）

### 设置：小模型分类开关

- 名称建议：`用小模型协助 Auto 分类` / `Use a small model to help Auto classify`
- **默认：关**（成本敏感）
- 仅当某处选择了 Auto 时该开关才有意义；关则纯启发式定档

## 内部档位（ChatGPT 心智）

用户主列表不展示下列 id；仅用于路由与高级映射配置。

| 档位 | 用户心智 | 典型用途 |
|---|---|---|
| `instant` | Instant | 短答、简单改写、低风险、要快 |
| `thinking` | Thinking | 多步、工具密集、中等以上复杂 |
| `pro` | Pro | 最难、长推理、高风险改动；可多等 |

第一版 **三档全上**（含 Pro）。

## 映射表

可配置（设置或 host config），形如：

```text
auto.instant  → { provider, model, reasoningEffort? }
auto.thinking → { provider, model, reasoningEffort? }
auto.pro      → { provider, model, reasoningEffort? }
auto.classifier → { provider, model }   # 仅开关打开时使用；应选便宜小模型
```

校验：映射目标必须在当前 Desktop 模型目录中可用；不可用则降级到下一档或会话默认模型，并在调试日志中记一条。

## 路由时机

### 主会话：每轮重路由

- 当会话当前选择为 Auto 时，**每一轮**（每次将发起的模型调用 / `prepareCall` 路径）重新定档并解析。
- UI 选择保持 Auto，不把解析结果写回为「钉死某模型」。
- 同一轮内多次辅助调用可共享本轮已解析结果（避免一轮内反复分类）。

### 插件辅助

- 该功能模型选择为 Auto 时：在该次 optimize / predict / compact 请求前定档。
- 为「跟随会话」且会话为 Auto 时：跟随本轮会话已解析的真实路由（或按辅助类型再定档——默认 **跟随本轮会话解析结果**，简单可预期）。
- 钉死固定模型：不走 Auto。

## 定档算法

### A. 启发式（开关关，或分类失败回退）

输入信号（可演进，第一版保持简单可测）：

- 用户文本长度 / 是否多段
- 是否显式要求深度（如「仔细」「深入」「分析」「plan」等，中英简单词表）
- 近期工具调用密度 / 是否处于重工具回合（若上下文可得）
- 辅助操作类型：`predict` 偏 instant；`optimize` 看长度；`compact` 偏 thinking（摘要质量）

粗映射：

- 短 + 无深度信号 → `instant`
- 中等或工具密集 → `thinking`
- 很长 + 深度信号或高风险标记 → `pro`

### B. 小模型分类（开关开）

- 调用 `auto.classifier` 映射的小模型。
- 约束输出仅为：`instant` | `thinking` | `pro`（结构化或严格词表）。
- 超时 / 解析失败 / 模型不可用 → 回退 A，不阻断主请求。
- 分类调用必须带独立超时与取消（跟随主 signal 或更短的子 timeout）。

## 架构落点（Agent 层）

```text
用户选择 Auto
    → Router.resolve(selection, turnContext, settings)
        → tier (instant|thinking|pro)
        → MappedRoute { provider, model, reasoningEffort? }
    → llm.prepareCall(MappedRoute, …)
```

- **不**改 LLM 网关协议。
- 主会话：挂在发车前解析 `agent.options` / 等价路由，仅当选择为 Auto 哨兵值时改写当次调用路由。
- 插件：现有 `AuxiliaryModels.route` 识别 Auto 哨兵后走同一 `Router`。
- Auto 哨兵建议：稳定伪选择，例如 `provider: 'agent-enhancer'`, `model: 'auto'`（或官方目录允许的占位）；实现时以「目录可展示 + 不会被真发到厂商」为准。

## 与现有能力的关系

| 现有 | 关系 |
|---|---|
| 固定模型 / 跟随会话 | 不变 |
| `agentDefaultModel` | 仍管「新会话默认」；若默认设为 Auto，则新会话每轮走路由 |
| 压缩独立模型 | 可选 Auto；规则上 compact 默认偏 thinking |
| 官方 `/compact` | 若通过命令路径，在执行前对 agent.options 做与现 compact 覆盖相同的临时路由 |

## 错误与降级

| 情况 | 行为 |
|---|---|
| Auto 映射缺失 | 回退会话默认或 `agentDefaultModel`；辅助功能则回退跟随会话 |
| 映射模型不在目录 | 尝试 thinking→instant 降级链；再不行用默认 |
| 分类器失败 | 静默回退启发式 |
| 非 Auto 选择 | 零路由开销 |

## 测试要点

- 钉死模型：路由器不被调用。
- Auto + 开关关：纯启发式档位稳定可单测。
- Auto + 开关开：mock 分类器输出三档；失败回退。
- 主会话连续两轮不同输入 → 可解析到不同档位（每轮重路由）。
- 辅助 Auto 与会话钉死 / 会话 Auto 的组合矩阵。
- zh/en 文案与设置键对齐。

## 实现分期

1. **Router 核心 + 映射配置 + 启发式 + 分类开关**（可先只接插件辅助，验证策略）
2. **主会话每轮挂接**（官方选择器出现 Auto）
3. **打磨映射 UI**（高级设置里编辑 Instant/Thinking/Pro/分类器模型）

若官方选择器短期无法注入伪模型，第 2 步可暂以「会话跟随插件级 Auto 策略」为过渡，但产品目标仍是选择器内的 Auto 项。

## 已确认决策

1. 范围：主会话 + 插件辅助（C）
2. Auto 仅为列表可选项，不取消固定模型
3. 档位心智：ChatGPT 系 Instant / Thinking / Pro（Pro 第一版上）
4. 小模型分类：用户开关，默认关
5. 主会话：每轮重路由
6. 落点：Agent 层，非 LLM 网关黑盒

## 开放实现细节（实现计划阶段再钉）

- Auto 哨兵在官方 catalog 中的具体注入方式（patch 目录 vs 选择器 UI 槽位）
- 启发式词表与阈值的精确阈值
- 映射配置的持久化字段名与设置页布局
