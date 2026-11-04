import { randomUUID } from 'node:crypto'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { CHECKPOINT_SCHEMA_VERSION } from './types.ts'
import type {
  Checkpoint,
  CheckpointGap,
  CheckpointSession,
  CheckpointStage,
  FileCheckpoint,
} from './types.ts'

export interface CheckpointWriter {
  save(checkpoint: Checkpoint): Promise<void>
}

export interface CaptureCheckpointOptions {
  readonly store: CheckpointWriter
  readonly sessionId: SessionId
  readonly session: CheckpointSession
  readonly pluginVersion: string
  readonly turnStart: SessionEvent<'turn/start'>
  readonly turnEnd?: SessionEvent<'turn/end'>
  readonly prompt: Pick<UserMessage, 'content' | 'source'>
  readonly flushSession: () => Promise<void>
  readonly captureFiles: () => Promise<readonly FileCheckpoint[]>
  readonly createId?: () => string
  readonly now?: () => number
  readonly onStage?: (stage: CheckpointStage) => void
}

/** Join text blocks only — attachments/chips must not wipe a typed prompt preview. */
export function textBlocksOf(
  content: readonly { readonly type: string, readonly text?: string }[],
): string {
  return content
    .flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('')
}

function directText(prompt: CaptureCheckpointOptions['prompt']): string | null {
  if (prompt.source.kind !== 'user' || prompt.content.length === 0) return null
  const text = textBlocksOf(prompt.content)
  return text.trim() === '' ? null : text
}

/** Recover a human prompt from session events when a stored checkpoint left it empty. */
export function recoverTurnPrompt(
  events: readonly SessionEvent[],
  turn: number,
): string {
  const turnStart = events.find(
    (event): event is SessionEvent<'turn/start'> =>
      event.type === 'turn/start' && event.data.turn === turn,
  )
  const turnEnd = events.find(
    (event): event is SessionEvent<'turn/end'> =>
      event.type === 'turn/end' && event.data.turn === turn,
  )
  if (turnStart === undefined || turnEnd === undefined) return ''
  for (const event of events) {
    if (event.type !== 'user/message') continue
    if (event.seq <= turnStart.seq || event.seq >= turnEnd.seq) continue
    if (event.data.source.kind !== 'user') continue
    const text = textBlocksOf(event.data.content)
    if (text.trim() !== '') return text
  }
  return ''
}

/** Inclusive keep-prefix end seq for a turn/start (never negative — store schema). */
export function checkpointAtSeq(turnStartSeq: number): number {
  return Math.max(0, turnStartSeq - 1)
}

/**
 * Exclusive cut for restore: events with seq > cut are rolled back.
 *
 * “Restore to here” on turn N withdraws turn N and everything after (cut just
 * before that turn’s `turn/start`). Pin the turn/start by stored `atSeq` when
 * the append-only log reuses turn numbers after undo.
 */
export function resolveRollbackCut(
  events: readonly SessionEvent[],
  turn: number,
  atSeq?: number,
): { readonly cutSeq: number } | null {
  const starts = events.filter(
    (event): event is SessionEvent<'turn/start'> =>
      event.type === 'turn/start' && event.data.turn === turn,
  )
  if (starts.length === 0) return null
  let turnStart = starts[0]!
  if (typeof atSeq === 'number') {
    const want = atSeq + 1
    const exact = starts.find(event => Number(event.seq) === want)
    if (exact !== undefined) {
      turnStart = exact
    } else {
      const after = [...starts].reverse().find(event => Number(event.seq) >= want)
      if (after !== undefined) turnStart = after
    }
  }
  return { cutSeq: Number(turnStart.seq) - 1 }
}

export async function captureCheckpoint(options: CaptureCheckpointOptions): Promise<Checkpoint | null> {
  options.onStage?.('preparing')
  // turn/start may be seq 0 when it is the first Session event (no end-seed/system).
  if (options.turnStart.seq < 0 || options.turnEnd === undefined
    || options.turnEnd.data.turn !== options.turnStart.data.turn) return null

  const prompt = directText(options.prompt)
  const gaps: CheckpointGap[] = []
  if (prompt === null) gaps.push({ type: 'prompt', reason: 'non-text-content' })

  await options.flushSession()
  options.onStage?.('session-flushed')

  let files: readonly FileCheckpoint[]
  try {
    files = await options.captureFiles()
  } catch (error) {
    // Live capture may attach already-tracked write/edit snapshots when the turn
    // is incomplete (e.g. shell used alongside write_file). Keep them so rollback
    // can still delete/restore those paths; the workspace gap warns about the rest.
    files = Array.isArray((error as { files?: unknown }).files)
      ? (error as { files: readonly FileCheckpoint[] }).files
      : []
    gaps.push({ type: 'workspace', reason: 'capture-failed' })
  }
  options.onStage?.('workspace-captured')

  const checkpoint: Checkpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    pluginVersion: options.pluginVersion,
    id: (options.createId ?? randomUUID)(),
    sessionId: options.sessionId,
    session: options.session,
    turn: options.turnStart.data.turn,
    atSeq: checkpointAtSeq(options.turnStart.seq),
    prompt: prompt ?? '',
    createdAt: (options.now ?? Date.now)(),
    stage: 'committed',
    coverage: gaps.length === 0 ? 'complete' : 'partial',
    gaps,
    files,
  }
  await options.store.save(checkpoint)
  options.onStage?.('committed')
  return checkpoint
}

export interface SynthesizeCheckpointOptions {
  readonly sessionId: SessionId
  readonly session: CheckpointSession
  readonly pluginVersion: string
  readonly turn: number
  readonly events: readonly SessionEvent[]
  readonly createId?: () => string
  readonly now?: () => number
}

/**
 * Build a conversation-only checkpoint from a closed turn when live capture missed
 * (cancelled turns, race before store commit, capture errors).
 */
export function synthesizeCheckpoint(options: SynthesizeCheckpointOptions): Checkpoint | null {
  const turnStart = options.events.find(
    (event): event is SessionEvent<'turn/start'> =>
      event.type === 'turn/start' && event.data.turn === options.turn,
  )
  const turnEnd = options.events.find(
    (event): event is SessionEvent<'turn/end'> =>
      event.type === 'turn/end' && event.data.turn === options.turn,
  )
  if (turnStart === undefined || turnEnd === undefined || turnStart.seq < 0) return null
  if (options.events.some((event, index) => Number(event.seq) !== index)) return null

  const user = options.events.find(
    (event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message'
      && event.data.source.kind === 'user'
      && event.seq > turnStart.seq
      && event.seq < turnEnd.seq,
  )
  const prompt = user === undefined ? null : directText(user.data)
  // No tracked files were observed; treat as a complete empty-files checkpoint so
  // UI does not scare users with soft "incomplete" gaps for conversation restore.
  const gaps: CheckpointGap[] = prompt === null
    ? [{ type: 'prompt', reason: 'non-text-content' }]
    : []

  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    pluginVersion: options.pluginVersion,
    id: (options.createId ?? randomUUID)(),
    sessionId: options.sessionId,
    session: options.session,
    turn: options.turn,
    atSeq: checkpointAtSeq(turnStart.seq),
    prompt: prompt ?? '',
    createdAt: (options.now ?? Date.now)(),
    stage: 'committed',
    coverage: gaps.length === 0 ? 'complete' : 'partial',
    gaps,
    files: [],
  }
}
