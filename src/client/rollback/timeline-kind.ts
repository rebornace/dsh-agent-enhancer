import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const CHECKPOINT_TIMELINE_TAB_ID = 'dsh-agent-enhancer/checkpointTimeline'
export const CHECKPOINT_TIMELINE_TAB_KIND = 'agentEnhancerCheckpointTimeline'

export interface CheckpointTimelineTabParams {
  readonly sessionId: SessionId
  readonly turn?: number
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    agentEnhancerCheckpointTimeline: CheckpointTimelineTabParams
  }
}
