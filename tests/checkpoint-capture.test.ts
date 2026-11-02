import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  captureCheckpoint,
  checkpointAtSeq,
  resolveRollbackCut,
  synthesizeCheckpoint,
} from '../src/host/checkpoint/capture.ts'
import type { CaptureCheckpointOptions } from '../src/host/checkpoint/capture.ts'
import type { Checkpoint, CheckpointStage } from '../src/host/checkpoint/types.ts'

const sessionId = SessionId('session-1')

function turnStart(seq = 10, turn = 4): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: SessionSeq(seq), time: 100, data: { turn } }
}

function turnEnd(turn = 4): SessionEvent<'turn/end'> {
  return {
    type: 'turn/end',
    seq: SessionSeq(20),
    time: 200,
    data: { turn, reason: { kind: 'completed' } },
  }
}

function directPrompt(text = '直接用户文本'): Pick<UserMessage, 'content' | 'source'> {
  return { source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

interface Harness {
  options: CaptureCheckpointOptions
  saved: Checkpoint[]
  calls: string[]
  stages: CheckpointStage[]
}

function harness(overrides: Partial<CaptureCheckpointOptions> = {}): Harness {
  const saved: Checkpoint[] = []
  const calls: string[] = []
  const stages: CheckpointStage[] = []
  const options: CaptureCheckpointOptions = {
    store: { async save(value) { calls.push('save'); saved.push(value) } },
    sessionId,
    session: { format: 4, preset: 'default' },
    pluginVersion: '0.2.0',
    turnStart: turnStart(),
    turnEnd: turnEnd(),
    prompt: directPrompt(),
    flushSession: async () => { calls.push('flush') },
    captureFiles: async () => {
      calls.push('files')
      return [{
        path: 'src/example.txt',
        change: 'modify',
        beforeText: 'before',
        beforeHash: 'before-hash',
        afterText: 'after',
        afterHash: 'after-hash',
      }]
    },
    createId: () => 'checkpoint-4',
    now: () => 1_234,
    onStage: stage => { stages.push(stage) },
    ...overrides,
  }
  return { options, saved, calls, stages }
}

describe('captureCheckpoint', () => {
  it('uses the inclusive boundary before turn.start and commits stages in order', async () => {
    const h = harness()

    const result = await captureCheckpoint(h.options)

    expect(result).toMatchObject({
      schemaVersion: 1,
      pluginVersion: '0.2.0',
      id: 'checkpoint-4',
      sessionId,
      session: { format: 4, preset: 'default' },
      turn: 4,
      atSeq: 9,
      prompt: '直接用户文本',
      createdAt: 1_234,
      stage: 'committed',
      coverage: 'complete',
      gaps: [],
    })
    expect(h.saved).toEqual([result])
    expect(h.calls).toEqual(['flush', 'files', 'save'])
    expect(h.stages).toEqual(['preparing', 'session-flushed', 'workspace-captured', 'committed'])
  })

  it('captures turn 1 after the system message with atSeq 0', async () => {
    const h = harness({
      turnStart: turnStart(1, 1),
      turnEnd: turnEnd(1),
    })

    await expect(captureCheckpoint(h.options)).resolves.toMatchObject({
      turn: 1,
      atSeq: 0,
      coverage: 'complete',
    })
    expect(h.saved).toHaveLength(1)
  })

  it('captures when turn.start is the first Session event (seq 0)', async () => {
    const h = harness({
      turnStart: turnStart(0, 1),
      turnEnd: turnEnd(1),
    })

    await expect(captureCheckpoint(h.options)).resolves.toMatchObject({
      turn: 1,
      atSeq: 0,
      coverage: 'complete',
    })
    expect(h.saved).toHaveLength(1)
  })

  it.each([
    { name: 'turn is still open', start: turnStart(), end: undefined },
    { name: 'turn.end belongs to another turn', start: turnStart(), end: turnEnd(5) },
  ])('does not flush, capture, or commit when $name', async ({ start, end }) => {
    const h = harness({ turnStart: start, turnEnd: end })

    await expect(captureCheckpoint(h.options)).resolves.toBeNull()
    expect(h.saved).toEqual([])
    expect(h.calls).toEqual([])
    expect(h.stages).toEqual(['preparing'])
  })

  it('joins multi-block plain text into a restorable draft', async () => {
    const h = harness({
      prompt: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }],
      },
    })

    await expect(captureCheckpoint(h.options)).resolves.toMatchObject({
      prompt: '第一段第二段',
      coverage: 'complete',
      gaps: [],
    })
  })

  it.each([
    { name: 'attachment', block: { type: 'file', ref: 'attachment-1' } },
    { name: 'chip', block: { type: 'chip', text: 'chip text' } },
  ])('marks complex $name content incomplete without inventing restorable prompt text', async ({ block }) => {
    const h = harness({
      prompt: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '不要拼接成草稿' }, block as never],
      },
    })

    const result = await captureCheckpoint(h.options)

    expect(result).toMatchObject({
      prompt: '',
      coverage: 'partial',
      gaps: [{ type: 'prompt', reason: 'non-text-content' }],
      stage: 'committed',
    })
    expect(h.saved).toEqual([result])
  })

  it('does not treat synthetic user-role content as direct user text', async () => {
    const h = harness({
      prompt: {
        source: { kind: 'agent.inject' },
        content: [{ type: 'text', text: '注入内容' }],
      } as unknown as Pick<UserMessage, 'content' | 'source'>,
    })

    await expect(captureCheckpoint(h.options)).resolves.toMatchObject({
      prompt: '',
      coverage: 'partial',
      gaps: [{ type: 'prompt', reason: 'non-text-content' }],
    })
  })

  it('commits a partial checkpoint when workspace capture fails without exposing error details', async () => {
    const h = harness({
      captureFiles: async () => { throw new Error('private path and provider details') },
    })

    const result = await captureCheckpoint(h.options)

    expect(result).toMatchObject({
      files: [],
      coverage: 'partial',
      gaps: [{ type: 'workspace', reason: 'capture-failed' }],
      stage: 'committed',
    })
    expect(JSON.stringify(result)).not.toContain('private path')
    expect(h.saved).toEqual([result])
    expect(h.stages).toEqual(['preparing', 'session-flushed', 'workspace-captured', 'committed'])
  })

  it('resolves rollback cuts from live turn/start even when stored atSeq is stale', () => {
    expect(checkpointAtSeq(0)).toBe(0)
    expect(checkpointAtSeq(1)).toBe(0)
    expect(checkpointAtSeq(2)).toBe(1)
    const head = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: {} },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'cancelled' } } },
    ] as SessionEvent[]
    expect(resolveRollbackCut(head, 1, 0)).toEqual({ cutSeq: -1 })
    const seeded = [
      { type: 'session/end-seed', seq: 0, time: 1, data: {} },
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 3, data: {} },
    ] as SessionEvent[]
    expect(resolveRollbackCut(seeded, 1, 0)).toEqual({ cutSeq: 0 })
    const withSystem = [
      { type: 'session/end-seed', seq: 0, time: 1, data: {} },
      { type: 'system/message', seq: 1, time: 2, data: {} },
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } },
      { type: 'user/message', seq: 3, time: 4, data: {} },
    ] as SessionEvent[]
    // Stale atSeq=0 would previously miss turn/start@2; turn lookup still cuts before it.
    expect(resolveRollbackCut(withSystem, 1, 0)).toEqual({ cutSeq: 1 })
  })

  it('synthesizes a checkpoint when turn 1 starts at seq 0', async () => {
    const events = [
      turnStart(0, 1),
      {
        type: 'user/message',
        seq: SessionSeq(1),
        time: 2,
        data: {
          id: 'user-1',
          role: 'user',
          content: [{ type: 'text', text: 'first line' }],
          source: { kind: 'user' },
        },
      },
      {
        type: 'turn/end',
        seq: SessionSeq(2),
        time: 3,
        data: { turn: 1, reason: { kind: 'cancelled' } },
      },
    ] as SessionEvent[]
    expect(synthesizeCheckpoint({
      sessionId,
      session: { format: 4, preset: null },
      pluginVersion: '0.2.0',
      turn: 1,
      events,
      createId: () => 'synthetic-1',
      now: () => 9,
    })).toMatchObject({
      turn: 1,
      atSeq: 0,
      prompt: 'first line',
      coverage: 'complete',
      files: [],
    })
  })
})
