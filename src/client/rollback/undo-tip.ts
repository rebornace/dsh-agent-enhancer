import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Session-scoped undo tip turn for the composer + / command menu. */
export class RollbackUndoTipStore {
  private readonly tips = new Map<string, number>()

  get(sessionId: SessionId): number | undefined {
    return this.tips.get(String(sessionId))
  }

  set(sessionId: SessionId, turn: number | undefined): void {
    const key = String(sessionId)
    if (turn === undefined) {
      this.tips.delete(key)
      return
    }
    this.tips.set(key, turn)
  }

  clear(sessionId?: SessionId): void {
    if (sessionId === undefined) {
      this.tips.clear()
      return
    }
    this.tips.delete(String(sessionId))
  }
}
