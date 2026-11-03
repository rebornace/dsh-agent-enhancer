import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RollbackController } from './controller.ts'
import type { RollbackUndoTipStore } from './undo-tip.ts'

/** Minimal face of `@deepseek-ai/dsh-client-ui-commands` used by this plugin. */
export interface CommandUiService {
  register(definition: {
    readonly name: string
    readonly label: () => string
    readonly description?: () => string
    readonly icon?: unknown
    readonly available?: (session: { readonly sessionId: SessionId }) => boolean
    readonly ui: {
      readonly kind: 'action'
      readonly run: (session: { readonly sessionId: SessionId }) => void
    }
  }): () => void
}

/**
 * Put「撤销恢复」in the composer + / command menu while an undo tip exists.
 * Same menu as the + button (`shortcut.slash`).
 */
export function installRollbackUndoCommand(options: {
  readonly ctx: Context
  readonly tips: RollbackUndoTipStore
  readonly rollbackFor: (sessionId: SessionId) => RollbackController
  readonly enabled: () => boolean
  readonly t: TranslateNS<'agent-enhancer'>
}): () => void {
  const fiber = options.ctx.inject(['commandUi'], (scope: Context) => {
    const commandUi = scope.get('commandUi') as CommandUiService | undefined
    if (commandUi === undefined || typeof commandUi.register !== 'function') return
    return scope.effect(() => commandUi.register({
      name: 'undo-restore',
      label: () => options.t('rollbackUndoAction'),
      description: () => options.t('rollbackUndoCommandDescription'),
      icon: IconRefreshOutlineRegular,
      available: session => {
        if (!options.enabled()) return false
        return options.tips.get(session.sessionId) !== undefined
      },
      ui: {
        kind: 'action',
        run: session => {
          const turn = options.tips.get(session.sessionId)
          if (turn === undefined || !options.enabled()) return
          options.rollbackFor(session.sessionId).open(turn, 'undo')
        },
      },
    }), 'agent-enhancer: undo-restore command')
  })

  return () => {
    void fiber.dispose()
  }
}
