import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useSyncExternalStore } from 'react'
import type { PromptSession } from '../prompt/session.ts'
import styles from '../styles.module.css'
import { OptimizeIcon, UndoIcon } from './icons.tsx'

export interface AgentControlsProps {
  readonly session: PromptSession
  readonly t: TranslateNS<'agent-enhancer'>
}

const OPTIMIZATION_ERROR_LOCALES = {
  MODEL_UNAVAILABLE: 'optimizeModelUnavailable',
  MODEL_FAILED: 'optimizeRequestFailed',
  INVALID_OUTPUT: 'optimizeInvalidOutput',
  ROLLBACK_FAILED: 'optimizeRollbackFailed',
  SESSION_CHANGED: 'optimizeSessionChanged',
} as const

export function AgentControls({ session, t }: AgentControlsProps) {
  const state = useSyncExternalStore(
    listener => session.subscribe(listener),
    () => session.controlsSnapshot(),
  )
  if (!state.enabled) return null
  const label = t(state.status === 'pending' ? 'optimizePending' : state.status === 'undo' ? 'optimizeUndo' : 'optimize')
  const errorLocale = OPTIMIZATION_ERROR_LOCALES[state.error ?? 'MODEL_FAILED']
  const tooltip = state.chipSelection ? t('optimizeChipSelection') : state.error !== null ? t(errorLocale)
    : state.hasChips ? t('optimizeChips') : label
  return <>
    <Tooltip label={tooltip}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={styles.toolbarIcon}
        data-agent-enhancer-icon={state.status}
        disabled={state.error === 'ROLLBACK_FAILED' || state.status === 'pending' || (state.status === 'optimize' && !state.canOptimize)}
        aria-label={label}
        title={tooltip}
        onClick={() => {
          if (state.status === 'undo') session.undo()
          else void session.optimize()
        }}
      >
        {state.status === 'pending' ? <StateDot state="ongoing" /> : state.status === 'undo' ? <UndoIcon /> : <OptimizeIcon />}
      </Button>
    </Tooltip>
    {state.error !== null && <span role="status">{t(errorLocale)}</span>}
  </>
}
