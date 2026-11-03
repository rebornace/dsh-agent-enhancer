export type InstallKind = 'npm' | 'link' | 'unknown'

export interface UpdateCheckResult {
  readonly current: string
  readonly latest: string | null
  readonly updateAvailable: boolean
  readonly installKind: InstallKind
  readonly canAutoApply: boolean
  readonly command: string
}

export interface ApplyUpdateResult {
  readonly ok: boolean
  readonly message: string
  readonly command?: string
}
