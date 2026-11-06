import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Max UTF-8 bytes accepted for in-app editing (simple daily edits). */
export const FILE_EDIT_MAX_BYTES = 2 * 1024 * 1024

export type FileEditErrorCode =
  | 'SESSION_CHANGED'
  | 'FILE_NOT_FOUND'
  | 'FILE_NOT_TEXT'
  | 'FILE_TOO_LARGE'
  | 'FILE_DENIED'
  | 'FILE_EDIT_FAILED'

export class FileEditError extends Error {
  constructor(
    readonly code: FileEditErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'FileEditError'
  }
}

export interface ReadWorkspaceFileRequest {
  readonly sessionId: SessionId
  readonly path: string
}

export interface ReadWorkspaceFileResult {
  readonly path: string
  readonly absolutePath: string
  readonly text: string
  readonly bytes: number
  readonly truncated: boolean
}

export interface WriteWorkspaceFileRequest {
  readonly sessionId: SessionId
  readonly path: string
  readonly content: string
}

export interface WriteWorkspaceFileResult {
  readonly path: string
  readonly absolutePath: string
  readonly bytes: number
}
