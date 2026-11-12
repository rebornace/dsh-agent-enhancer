/** Thrown when Auto is selected but Instant / Thinking / Pro are all unset or unusable. */
export class AutoRouteUnconfiguredError extends Error {
  readonly code = 'AUTO_ROUTE_UNCONFIGURED' as const

  constructor(
    message = 'Auto routing is not configured. Open Settings → Built-in plugins → Agent Enhancer → Models & routing and map Instant / Thinking / Pro to real models.',
  ) {
    super(message)
    this.name = 'AutoRouteUnconfiguredError'
  }
}

/** Host-visible bilingual copy for session chat / prepareCall failures. */
export const AUTO_ROUTE_UNCONFIGURED_LLM_MESSAGE =
  'Auto routing is not configured / 尚未配置 Auto 档位模型。'
  + ' Open Settings → Built-in plugins → Agent Enhancer → Models & routing'
  + '（设置 → 内置插件 → 智能体增强 → 模型与路由）and map Instant / Thinking / Pro.'
