import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const EXTRA_FOLDERS_VERSION = 1 as const
export const EXTRA_FOLDERS_MAX_ROOTS = 16

export type ExtraFoldersErrorCode =
  | 'SESSION_CHANGED'
  | 'FILE_NOT_FOUND'
  | 'FILE_DENIED'
  | 'FILE_EDIT_FAILED'

export class ExtraFoldersError extends Error {
  constructor(
    readonly code: ExtraFoldersErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'ExtraFoldersError'
  }
}

export interface ExtraFolderRoot {
  readonly path: string
  readonly title: string
}

export interface ExtraFoldersDocument {
  readonly version: typeof EXTRA_FOLDERS_VERSION
  readonly primaryCwd: string
  readonly roots: readonly ExtraFolderRoot[]
}

export interface ExtraFolderEntry {
  readonly name: string
  readonly path: string
  readonly absolutePath: string
  readonly kind: 'directory' | 'file'
}

export interface ListExtraFoldersRequest {
  readonly sessionId: SessionId
}

export interface ListExtraFoldersResult {
  readonly primaryCwd: string
  readonly primaryTitle: string
  readonly roots: readonly ExtraFolderRoot[]
}

export interface AddExtraFolderRequest {
  readonly sessionId: SessionId
  readonly path: string
  readonly title?: string
}

export interface PickExtraFolderRequest {
  readonly sessionId: SessionId
}

export interface PickExtraFolderResult {
  /** Null when the user cancelled the OS folder dialog. */
  readonly path: string | null
  readonly primaryCwd: string
  readonly primaryTitle: string
  readonly roots: readonly ExtraFolderRoot[]
  /** True when a folder was picked and attached. */
  readonly added: boolean
}

export interface RemoveExtraFolderRequest {
  readonly sessionId: SessionId
  readonly path: string
}

export interface ListExtraFolderEntriesRequest {
  readonly sessionId: SessionId
  /** Absolute root path (primary or attached). */
  readonly rootPath: string
  /** Relative path under the root; empty = root itself. */
  readonly relativePath?: string
}

export interface ListExtraFolderEntriesResult {
  readonly rootPath: string
  readonly relativePath: string
  readonly entries: readonly ExtraFolderEntry[]
}
