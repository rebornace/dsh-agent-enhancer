export const AUXILIARY_ERROR_CODES = [
  'MODEL_UNAVAILABLE', 'MODEL_FAILED', 'INVALID_OUTPUT', 'SESSION_CHANGED', 'ROLLBACK_FAILED',
] as const
export type AuxiliaryErrorCode = typeof AUXILIARY_ERROR_CODES[number]
const MESSAGES: Record<AuxiliaryErrorCode, string> = {
  MODEL_UNAVAILABLE: 'No model is available for Composer Enhance',
  MODEL_FAILED: 'Auxiliary model request failed',
  INVALID_OUTPUT: 'Auxiliary model returned invalid output',
  SESSION_CHANGED: 'The session changed during the auxiliary request',
  ROLLBACK_FAILED: 'The draft could not be restored after a failed write',
}
export class AuxiliaryError extends Error {
  constructor(readonly code: AuxiliaryErrorCode) {
    super(MESSAGES[code])
    this.name = 'AuxiliaryError'
  }
}
