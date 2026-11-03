import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { installRollbackUndoCommand } from '../src/client/rollback/command-ui.ts'
import { RollbackController } from '../src/client/rollback/controller.ts'
import { RollbackUndoTipStore } from '../src/client/rollback/undo-tip.ts'
import { agentLocales } from '../src/client/locales.ts'

const sessionId = 'session-1' as SessionId

describe('RollbackUndoTipStore', () => {
  it('stores and clears per-session tip turns', () => {
    const tips = new RollbackUndoTipStore()
    tips.set(sessionId, 2)
    expect(tips.get(sessionId)).toBe(2)
    tips.set(sessionId, undefined)
    expect(tips.get(sessionId)).toBeUndefined()
  })
})

describe('installRollbackUndoCommand', () => {
  it('registers an action that opens undo only while a tip exists', () => {
    const tips = new RollbackUndoTipStore()
    const open = vi.fn()
    const register = vi.fn().mockReturnValue(() => {})
    const effect = vi.fn((run: () => () => void) => run())
    const disposeFiber = vi.fn()
    const ctx = {
      inject: (_deps: string[], body: (scope: unknown) => unknown) => {
        body({
          get: () => ({ register }),
          effect,
        })
        return { dispose: disposeFiber }
      },
    }
    const rollback = {
      open,
    } as unknown as RollbackController

    const dispose = installRollbackUndoCommand({
      ctx: ctx as never,
      tips,
      rollbackFor: () => rollback,
      enabled: () => true,
      t: ((key: string) => agentLocales.en[key as keyof typeof agentLocales.en]) as never,
    })

    expect(register).toHaveBeenCalledOnce()
    const definition = register.mock.calls[0]![0] as {
      name: string
      available: (session: { sessionId: SessionId }) => boolean
      ui: { kind: string, run: (session: { sessionId: SessionId }) => void }
    }
    expect(definition.name).toBe('undo-restore')
    expect(definition.available({ sessionId })).toBe(false)

    tips.set(sessionId, 2)
    expect(definition.available({ sessionId })).toBe(true)
    definition.ui.run({ sessionId })
    expect(open).toHaveBeenCalledWith(2, 'undo')

    dispose()
    expect(disposeFiber).toHaveBeenCalledOnce()
  })
})
