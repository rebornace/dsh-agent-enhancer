import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const CHECKPOINT_SCHEMA_VERSION = 1 as const

export type CheckpointStage = 'preparing' | 'session-flushed' | 'workspace-captured' | 'committed'
export type CheckpointCoverage = 'complete' | 'partial'

export interface CheckpointSession {
  readonly format: number
  readonly preset: string | null
}

export type CheckpointGap =
  | { readonly type: 'prompt'; readonly reason: 'non-text-content' }
  | { readonly type: 'workspace'; readonly reason: 'capture-failed' }

export interface FileCheckpoint {
  readonly path: string
  readonly change: 'create' | 'modify' | 'delete'
  readonly beforeText: string | null
  readonly beforeHash: string
  readonly afterHash: string
}

export interface Checkpoint {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION
  readonly pluginVersion: string
  readonly id: string
  readonly sessionId: SessionId
  readonly session: CheckpointSession
  readonly turn: number
  readonly atSeq: number
  readonly prompt: string
  readonly createdAt: number
  readonly stage: 'committed'
  readonly coverage: CheckpointCoverage
  readonly gaps: readonly CheckpointGap[]
  readonly files: readonly FileCheckpoint[]
}

export interface CheckpointJournal {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION
  readonly id: string
  readonly sessionId: SessionId
  readonly checkpointId: string
  readonly status: 'prepared' | 'files-restored' | 'completed' | 'compensated'
  readonly createdAt: number
}
