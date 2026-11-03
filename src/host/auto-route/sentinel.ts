export const AUTO_PROVIDER = 'agent-enhancer'
export const AUTO_MODEL = 'auto'

export function isAutoSelection(selection: { provider: string; model: string }): boolean {
  return selection.provider === AUTO_PROVIDER && selection.model === AUTO_MODEL
}
