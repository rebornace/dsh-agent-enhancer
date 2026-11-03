import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type AuxiliaryOperation = 'optimize' | 'predict'
export type UiLocale = 'zh' | 'en'
export interface ModelRoute { readonly provider: string; readonly model: string }
export interface RecentExchange {
  readonly turn: number
  readonly prompt: string
  readonly response: string
}
export interface OptimizeReference {
  readonly offset: number
  readonly length: number
  readonly text: string
}
export interface OptimizeRequest {
  readonly operation: 'optimize'
  readonly requestId: string
  readonly sessionId: SessionId
  readonly source: string
  readonly references: readonly OptimizeReference[]
  readonly context: readonly RecentExchange[]
  /** Desktop UI language; Host prompt pack follows this when present. */
  readonly uiLocale?: UiLocale
}
export interface PredictRequest extends Omit<OptimizeRequest, 'operation' | 'source' | 'references'> {
  readonly operation: 'predict'
}
export type AuxiliaryRequest = OptimizeRequest | PredictRequest
export interface AuxiliaryResult {
  readonly requestId: string
  readonly text: string
  readonly route: ModelRoute
  readonly segments?: readonly string[]
}
export interface AgentRequestAudit {
  readonly operation: AuxiliaryOperation
  readonly requestId: string
  readonly route: ModelRoute
  readonly system: string
  readonly messages: GenerateOptions['messages']
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:agent-enhancer/request': AgentRequestAudit
  }
}
