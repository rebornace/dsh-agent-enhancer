import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextInspectCategory } from '../../host/context-inspect.ts'

export const CONTEXT_INSPECT_TAB_ID = 'dsh-agent-enhancer/contextInspect'
export const CONTEXT_INSPECT_TAB_KIND = 'agentEnhancerContextInspect'

export interface ContextInspectTabParams {
  readonly sessionId: SessionId
  readonly category: ContextInspectCategory
  readonly itemId?: string
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    agentEnhancerContextInspect: ContextInspectTabParams
  }
}
