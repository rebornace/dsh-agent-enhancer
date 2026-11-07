/**
 * Left nav panel list seat — not yet merged in all Desktop peer type packages;
 * declare the seam this plugin registers into (peers dshmarket `sidebar.panellist`).
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
