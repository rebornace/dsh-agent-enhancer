export const AUXILIARY_ERROR_CODES = [
  'MODEL_UNAVAILABLE', 'MODEL_FAILED', 'INVALID_OUTPUT', 'SESSION_CHANGED', 'ROLLBACK_FAILED',
  'COMPACT_UNAVAILABLE', 'COMPACT_BUSY', 'COMPACT_FAILED', 'COMPACT_SUMMARY', 'COMPACT_CHANGED',
  'SESSION_BUSY', 'SESSION_DELETE_FAILED',
] as const
export type AuxiliaryErrorCode = typeof AUXILIARY_ERROR_CODES[number]
const MESSAGES: Record<AuxiliaryErrorCode, string> = {
  MODEL_UNAVAILABLE: 'No model is available for Agent Enhance',
  MODEL_FAILED: 'Auxiliary model request failed',
  INVALID_OUTPUT: 'Auxiliary model returned invalid output',
  SESSION_CHANGED: 'The session changed during the auxiliary request',
  ROLLBACK_FAILED: 'The draft could not be restored after a failed write',
  COMPACT_UNAVAILABLE: 'Official compaction is not available in this session',
  COMPACT_BUSY: 'Compaction is unavailable while the agent is busy',
  COMPACT_FAILED: 'Compaction did not finish; the conversation is unchanged or only partially updated',
  COMPACT_SUMMARY: 'Compaction could not produce a useful summary; the conversation is unchanged',
  COMPACT_CHANGED: 'History changed during compaction; the conversation is unchanged',
  SESSION_BUSY: 'The session is running and cannot be deleted yet',
  SESSION_DELETE_FAILED: 'Session delete did not finish cleanly',
}
export class AuxiliaryError extends Error {
  constructor(readonly code: AuxiliaryErrorCode, message?: string) {
    super(message ?? MESSAGES[code])
    this.name = 'AuxiliaryError'
  }
}
