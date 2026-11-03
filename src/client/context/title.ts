import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextInspectItem, ContextInspectKind } from '../../host/context-inspect.ts'

function kindLabel(kind: ContextInspectKind, t: TranslateNS<'agent-enhancer'>): string {
  switch (kind) {
    case 'system':
      return t('contextInspectCategory_system')
    case 'tools':
      return t('contextInspectCategory_tools')
    case 'user':
      return t('contextInspectKind_user')
    case 'inject':
      return t('contextInspectKind_inject')
    case 'assistant':
      return t('contextInspectKind_assistant')
    case 'tool':
      return t('contextInspectKind_tool')
    case 'developer':
      return t('contextInspectKind_developer')
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

/** Localize host English role titles while keeping specific names (tools, inject sources). */
export function localizeItemTitle(
  item: ContextInspectItem,
  t: TranslateNS<'agent-enhancer'>,
): string {
  const label = kindLabel(item.kind, t)
  switch (item.kind) {
    case 'system':
      if (item.title === 'System') return label
      if (/^System · \d+$/.test(item.title)) return item.title.replace(/^System/, label)
      return item.title
    case 'user':
      return item.title === 'User' ? label : item.title
    case 'assistant':
      return item.title === 'Assistant' ? label : item.title
    case 'developer':
      return item.title === 'Developer' ? label : item.title
    case 'inject':
      return item.title.startsWith('Inject · ')
        ? `${label} · ${item.title.slice('Inject · '.length)}`
        : item.title
    case 'tool':
      return item.title.startsWith('Tool · ')
        ? `${label} · ${item.title.slice('Tool · '.length)}`
        : item.title
    case 'tools':
      return item.title
    default: {
      const _exhaustive: never = item.kind
      return _exhaustive
    }
  }
}
