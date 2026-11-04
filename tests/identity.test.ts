import { describe, expect, it } from 'vitest'
import {
  isRollbackId,
  isUndoId,
  LEGACY_PACKAGE_NAME,
  PACKAGE_NAME,
  PLUGIN_ID,
  turnFromRollbackId,
} from '../src/identity.ts'

describe('package identity', () => {
  it('uses the agent-enhancer names', () => {
    expect(PACKAGE_NAME).toBe('dsh-agent-enhancer')
    expect(PLUGIN_ID).toBe('agent-enhancer')
    expect(LEGACY_PACKAGE_NAME).toBe('dsh-composer-enhancer')
  })

  it('recognizes current and legacy rollback / undo ids', () => {
    expect(isRollbackId('dsh-agent-enhancer:rollback:2:journal')).toBe(true)
    expect(isRollbackId('dsh-composer-enhancer:rollback:2:journal')).toBe(true)
    expect(isUndoId('dsh-agent-enhancer:undo:restore-1:0')).toBe(true)
    expect(isUndoId('dsh-composer-enhancer:undo:restore-1:0')).toBe(true)
    expect(turnFromRollbackId('dsh-composer-enhancer:rollback:7:x')).toBe(7)
    expect(turnFromRollbackId('dsh-agent-enhancer:rollback:3:c:x')).toBe(3)
    expect(turnFromRollbackId(
      'dsh-agent-enhancer:undo:j1:2:15:dsh-agent-enhancer:rollback:2:j0',
    )).toBe(2)
    expect(turnFromRollbackId(
      'dsh-composer-enhancer:undo:j1:0:9:dsh-composer-enhancer:rollback:4:c:j0',
    )).toBe(4)
  })
})
