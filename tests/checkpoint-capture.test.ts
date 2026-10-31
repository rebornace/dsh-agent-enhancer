import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { captureCheckpoint } from '../src/host/checkpoint/capture.ts'
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

  it.each([
    { name: 'turn is still open', start: turnStart(), end: undefined },
    { name: 'turn.start is the first Session event', start: turnStart(0), end: turnEnd() },
    { name: 'turn.end belongs to another turn', start: turnStart(), end: turnEnd(5) },
  ])('does not flush, capture, or commit when $name', async ({ start, end }) => {
    const h = harness({ turnStart: start, turnEnd: end })

    await expect(captureCheckpoint(h.options)).resolves.toBeNull()
    expect(h.saved).toEqual([])
    expect(h.calls).toEqual([])
    expect(h.stages).toEqual(['preparing'])
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
})
