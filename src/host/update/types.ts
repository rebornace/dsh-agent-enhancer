export type InstallKind = 'npm' | 'link' | 'unknown'

export interface UpdateCheckResult {
  readonly current: string
  readonly latest: string | null
  readonly updateAvailable: boolean
  readonly installKind: InstallKind
  readonly canAutoApply: boolean
  readonly command: string
}

export const APPLY_UPDATE_CODES = ['restart', 'link', 'manual', 'none', 'failed'] as const

export type ApplyUpdateCode = (typeof APPLY_UPDATE_CODES)[number]

export interface ApplyUpdateResult {
  readonly ok: boolean
  readonly message: ApplyUpdateCode
  readonly command?: string
}
