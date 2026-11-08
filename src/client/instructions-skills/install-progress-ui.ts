import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SkillInstallProgress,
  SkillInstallStage,
} from '../../host/instructions-skills/types.ts'

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KB`
  const mib = kib / 1024
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MB`
}

export function skillInstallStageLabel(
  stage: SkillInstallStage,
  t: TranslateNS<'agent-enhancer'>,
): string {
  switch (stage) {
    case 'idle':
      return t('instructionsSkillsInstalling')
    case 'resolving':
      return t('instructionsSkillsInstallStageResolving')
    case 'downloading':
      return t('instructionsSkillsInstallStageDownloading')
    case 'extracting':
      return t('instructionsSkillsInstallStageExtracting')
    case 'cloning':
      return t('instructionsSkillsInstallStageCloning')
    case 'copying':
      return t('instructionsSkillsInstallStageCopying')
    case 'finishing':
      return t('instructionsSkillsInstallStageFinishing')
    default: {
      const _exhaustive: never = stage
      return _exhaustive
    }
  }
}

/** Human-readable status for the Add sheet / update banner. */
export function formatSkillInstallProgressLine(
  progress: SkillInstallProgress,
  nowMs: number,
  t: TranslateNS<'agent-enhancer'>,
): string {
  const stage = skillInstallStageLabel(progress.stage === 'idle' ? 'resolving' : progress.stage, t)
  const startedAt = progress.startedAt ?? nowMs
  const seconds = Math.max(0, Math.floor((nowMs - startedAt) / 1000))
  let line = t('instructionsSkillsInstallProgressLine')
    .replace('{stage}', stage)
    .replace('{seconds}', String(seconds))

  const detail = progress.detail?.trim() ?? ''
  if (detail !== '' && progress.stage === 'copying') {
    line = `${line} · ${detail}`
  } else if (detail !== '' && /retry/i.test(detail)) {
    line = `${line} · ${detail}`
  }

  if (progress.bytesReceived !== null) {
    // Clone reports percent as received/total with total === 100.
    if (
      progress.stage === 'cloning'
      && progress.bytesTotal === 100
    ) {
      line = `${line} · ${Math.round(progress.bytesReceived)}%`
    } else {
      const received = formatByteSize(progress.bytesReceived)
      const total = progress.bytesTotal !== null ? formatByteSize(progress.bytesTotal) : null
      const bytesText = total === null
        ? t('instructionsSkillsInstallProgressBytesUnknown').replace('{received}', received)
        : t('instructionsSkillsInstallProgressBytes')
          .replace('{received}', received)
          .replace('{total}', total)
      line = `${line} · ${bytesText}`
    }
  }
  return line
}
