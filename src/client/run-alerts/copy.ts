import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RunAlertEvent } from './types.ts'

function fill(template: string, vars: Record<string, string>): string {
  let out = template
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(value)
  }
  return out
}

export function runAlertBody(
  t: TranslateNS<'agent-enhancer'>,
  event: RunAlertEvent,
  title: string,
): string {
  const safeTitle = title.trim() === '' ? String(event.sessionId) : title.trim()
  switch (event.kind) {
    case 'finished':
      return fill(t('runAlertsFinished'), { title: safeTitle })
    case 'pending': {
      switch (event.pendingKind) {
        case 'approval':
          return fill(t('runAlertsWaitingApproval'), { title: safeTitle })
        case 'question':
          return fill(t('runAlertsWaitingQuestion'), { title: safeTitle })
        case 'plan-review':
          return fill(t('runAlertsWaitingPlanReview'), { title: safeTitle })
        default:
          return fill(t('runAlertsWaiting'), { title: safeTitle })
      }
    }
    case 'error':
      return fill(t('runAlertsError'), {
        title: safeTitle,
        message: event.message ?? '—',
      })
    default: {
      const _exhaustive: never = event.kind
      return _exhaustive
    }
  }
}
