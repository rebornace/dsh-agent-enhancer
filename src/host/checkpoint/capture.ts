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

function directText(prompt: CaptureCheckpointOptions['prompt']): string | null {
  if (prompt.source.kind !== 'user' || prompt.content.length !== 1) return null
  const content = prompt.content[0]!
  return content.type === 'text' ? content.text : null
}

export async function captureCheckpoint(options: CaptureCheckpointOptions): Promise<Checkpoint | null> {
  options.onStage?.('preparing')
  if (options.turnStart.seq <= 0 || options.turnEnd === undefined
    || options.turnEnd.data.turn !== options.turnStart.data.turn) return null

  const prompt = directText(options.prompt)
  const gaps: CheckpointGap[] = []
  if (prompt === null) gaps.push({ type: 'prompt', reason: 'non-text-content' })

  await options.flushSession()
  options.onStage?.('session-flushed')

  let files: readonly FileCheckpoint[]
  try {
    files = await options.captureFiles()
  } catch {
    files = []
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
    atSeq: options.turnStart.seq - 1,
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
