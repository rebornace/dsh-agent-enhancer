/**
 * In-memory GitHub skill install progress, keyed by sessionId.
 * Client polls via getSkillInstallProgress while installSkillFromGit runs.
 */

export const SKILL_INSTALL_STAGES = [
  'idle',
  'resolving',
  'downloading',
  'extracting',
  'cloning',
  'copying',
  'finishing',
] as const

export type SkillInstallStage = typeof SKILL_INSTALL_STAGES[number]

export interface SkillInstallProgress {
  readonly sessionId: string
  readonly stage: SkillInstallStage
  readonly detail: string | null
  readonly bytesReceived: number | null
  readonly bytesTotal: number | null
  readonly startedAt: number | null
}

interface MutableProgress {
  sessionId: string
  stage: SkillInstallStage
  detail: string | null
  bytesReceived: number | null
  bytesTotal: number | null
  startedAt: number | null
}

const bySession = new Map<string, MutableProgress>()

function idleSnapshot(sessionId: string): SkillInstallProgress {
  return {
    sessionId,
    stage: 'idle',
    detail: null,
    bytesReceived: null,
    bytesTotal: null,
    startedAt: null,
  }
}

function snapshotOf(entry: MutableProgress): SkillInstallProgress {
  return {
    sessionId: entry.sessionId,
    stage: entry.stage,
    detail: entry.detail,
    bytesReceived: entry.bytesReceived,
    bytesTotal: entry.bytesTotal,
    startedAt: entry.startedAt,
  }
}

export function beginSkillInstallProgress(sessionId: string, detail?: string | null): void {
  const id = sessionId.trim()
  if (id === '') return
  bySession.set(id, {
    sessionId: id,
    stage: 'resolving',
    detail: detail?.trim() || null,
    bytesReceived: null,
    bytesTotal: null,
    startedAt: Date.now(),
  })
}

export function setSkillInstallStage(
  sessionId: string,
  stage: Exclude<SkillInstallStage, 'idle'>,
  detail?: string | null,
): void {
  const id = sessionId.trim()
  if (id === '') return
  const existing = bySession.get(id)
  if (existing === undefined) {
    bySession.set(id, {
      sessionId: id,
      stage,
      detail: detail?.trim() || null,
      bytesReceived: null,
      bytesTotal: null,
      startedAt: Date.now(),
    })
    return
  }
  const prev = existing.stage
  existing.stage = stage
  if (detail !== undefined) {
    existing.detail = detail?.trim() || null
  }
  // Keep byte/percent counters only while downloading or cloning.
  if (
    (stage !== 'downloading' && stage !== 'cloning')
    || (prev !== stage && (stage === 'downloading' || stage === 'cloning'))
  ) {
    if (stage !== 'downloading' && stage !== 'cloning') {
      existing.bytesReceived = null
      existing.bytesTotal = null
    } else if (prev !== stage) {
      existing.bytesReceived = null
      existing.bytesTotal = null
    }
  }
}

/** Update transfer or clone fraction without forcing the stage name. */
export function setSkillInstallBytes(
  sessionId: string,
  bytesReceived: number,
  bytesTotal: number | null,
): void {
  const id = sessionId.trim()
  if (id === '') return
  const existing = bySession.get(id)
  if (existing === undefined) return
  existing.bytesReceived = Number.isFinite(bytesReceived) ? Math.max(0, bytesReceived) : null
  existing.bytesTotal = bytesTotal !== null && Number.isFinite(bytesTotal) && bytesTotal > 0
    ? bytesTotal
    : null
}

export function clearSkillInstallProgress(sessionId: string): void {
  const id = sessionId.trim()
  if (id === '') return
  bySession.delete(id)
}

export function getSkillInstallProgressSnapshot(sessionId: string): SkillInstallProgress {
  const id = sessionId.trim()
  if (id === '') return idleSnapshot('')
  const existing = bySession.get(id)
  if (existing === undefined) return idleSnapshot(id)
  return snapshotOf(existing)
}

/** Test helper — wipe all sessions. */
export function resetSkillInstallProgressForTests(): void {
  bySession.clear()
}
