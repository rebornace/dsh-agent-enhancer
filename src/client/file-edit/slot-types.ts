/**
 * Desktop 0.2.2 document-preview actions list. Official package may not be a
 * compile-time peer of this plugin, so we declare the seam we use.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.right.tab.document.actions': {
      kind: 'list'
      scope: 'session'
      owner: {
        readonly absolutePath: string
      }
    }
  }
}
