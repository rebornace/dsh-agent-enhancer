export const USAGE_TAB_ID = 'dsh-agent-enhancer/usage'
export const USAGE_TAB_KIND = 'agentEnhancerUsage'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    agentEnhancerUsage: Record<string, never>
  }
}
