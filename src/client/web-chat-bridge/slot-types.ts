/**
 * Left nav panel list seat — shared with Skills / MCP; declare for web-chat panel registration.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.panellist': {
      kind: 'list'
      scope: 'root'
      owner: {
        readonly size?: number
      }
    }
  }
}

export {}
