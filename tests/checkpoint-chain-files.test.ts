import { describe, expect, it } from 'vitest'
import { chainTrackedFiles, netFileChange } from '../src/host/checkpoint/chain-files.ts'
import type { Checkpoint, FileCheckpoint } from '../src/host/checkpoint/types.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'

function file(
  path: string,
  change: FileCheckpoint['change'],
  before: string | null,
  after: string | null,
): FileCheckpoint {
  const hash = (text: string | null) => (text === null ? '' : `h:${text}`)
  return {
    path,
    change,
    beforeText: before,
    beforeHash: hash(before),
    afterText: after,
    afterHash: hash(after),
  }
}

function checkpoint(turn: number, files: readonly FileCheckpoint[]): Checkpoint {
  return {
    schemaVersion: 1,
    pluginVersion: 'test',
    id: `cp-${turn}`,
    sessionId: 'session-1' as SessionId,
    session: { format: 1, preset: null },
    turn,
    atSeq: turn * 10,
    prompt: `prompt ${turn}`,
    createdAt: turn,
    stage: 'committed',
    coverage: 'complete',
    gaps: [],
    files,
  }
}

describe('chainTrackedFiles', () => {
  it('keeps earliest before and latest after across the restore chain', () => {
    const chained = chainTrackedFiles([
      checkpoint(2, [file('a.ts', 'modify', 'v1', 'v2')]),
      checkpoint(3, [file('b.ts', 'create', null, 'new')]),
      checkpoint(4, [file('a.ts', 'modify', 'v2', 'v4')]),
    ], 2)
    expect(chained).toEqual([
      file('a.ts', 'modify', 'v1', 'v4'),
      file('b.ts', 'create', null, 'new'),
    ])
  })

  it('ignores checkpoints before the target turn', () => {
    const chained = chainTrackedFiles([
      checkpoint(1, [file('old.ts', 'modify', 'a', 'b')]),
      checkpoint(3, [file('new.ts', 'modify', 'c', 'd')]),
    ], 3)
    expect(chained).toEqual([file('new.ts', 'modify', 'c', 'd')])
  })

  it('stops before an already-restored live tip when deepening a cut', () => {
    const chained = chainTrackedFiles([
      checkpoint(1, [file('a.ts', 'modify', 'v0', 'v1')]),
      checkpoint(2, [file('a.ts', 'modify', 'v1', 'v2')]),
      checkpoint(3, [file('b.ts', 'create', null, 'new')]),
    ], 1, 2)
    expect(chained).toEqual([file('a.ts', 'modify', 'v0', 'v1')])
  })

  it('classifies net create/delete across the chain', () => {
    expect(netFileChange(file('x', 'create', null, 'a'), file('x', 'modify', 'a', 'b'))).toBe('create')
    expect(netFileChange(
      file('x', 'modify', 'a', 'b'),
      file('x', 'delete', 'b', null),
    )).toBe('delete')
    expect(netFileChange(
      file('x', 'create', null, 'a'),
      file('x', 'delete', 'a', null),
    )).toBeNull()
  })

  it('drops create-then-delete paths so invalid create rows cannot block the chain', () => {
    const chained = chainTrackedFiles([
      checkpoint(1, [file('gone.txt', 'create', null, 'tmp'), file('keep.txt', 'create', null, 'ok')]),
      checkpoint(2, [file('gone.txt', 'delete', 'tmp', null)]),
    ], 1)
    expect(chained).toEqual([file('keep.txt', 'create', null, 'ok')])
  })
})
