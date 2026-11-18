import { afterEach, describe, expect, it } from 'vitest'
import {
  beginSkillInstallProgress,
  clearSkillInstallProgress,
  getSkillInstallProgressSnapshot,
  resetSkillInstallProgressForTests,
  setSkillInstallBytes,
  setSkillInstallStage,
} from '../src/host/instructions-skills/install-progress.ts'
import { formatSkillInstallProgressLine } from '../src/client/instructions-skills/install-progress-ui.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

afterEach(() => {
  resetSkillInstallProgressForTests()
})

describe('skill install progress tracker', () => {
  it('starts resolving and clears to idle', () => {
    beginSkillInstallProgress('sess-1', 'owner/repo')
    expect(getSkillInstallProgressSnapshot('sess-1')).toMatchObject({
      sessionId: 'sess-1',
      stage: 'resolving',
      detail: 'owner/repo',
      bytesReceived: null,
      bytesTotal: null,
    })
    expect(getSkillInstallProgressSnapshot('sess-1').startedAt).toEqual(expect.any(Number))

    setSkillInstallStage('sess-1', 'downloading')
    setSkillInstallBytes('sess-1', 1024, 4096)
    expect(getSkillInstallProgressSnapshot('sess-1')).toMatchObject({
      stage: 'downloading',
      bytesReceived: 1024,
      bytesTotal: 4096,
    })

    setSkillInstallStage('sess-1', 'extracting')
    expect(getSkillInstallProgressSnapshot('sess-1')).toMatchObject({
      stage: 'extracting',
      bytesReceived: null,
      bytesTotal: null,
    })

    clearSkillInstallProgress('sess-1')
    expect(getSkillInstallProgressSnapshot('sess-1').stage).toBe('idle')
  })

  it('isolates sessions', () => {
    beginSkillInstallProgress('a', 'one')
    beginSkillInstallProgress('b', 'two')
    setSkillInstallStage('a', 'cloning')
    expect(getSkillInstallProgressSnapshot('a').stage).toBe('cloning')
    expect(getSkillInstallProgressSnapshot('b').stage).toBe('resolving')
  })
})

describe('formatSkillInstallProgressLine', () => {
  const translations: Record<string, string> = {
    instructionsSkillsInstalling: 'Installing…',
    instructionsSkillsInstallStageResolving: 'Resolving source',
    instructionsSkillsInstallStageDownloading: 'Downloading repo',
    instructionsSkillsInstallStageExtracting: 'Extracting',
    instructionsSkillsInstallStageCloning: 'Cloning repo',
    instructionsSkillsInstallStageCopying: 'Copying skills',
    instructionsSkillsInstallStageFinishing: 'Refreshing list',
    instructionsSkillsInstallProgressLine: '{stage} · {seconds}s elapsed',
    instructionsSkillsInstallProgressBytes: '{received} / {total}',
    instructionsSkillsInstallProgressBytesUnknown: '{received} downloaded',
  }
  const t: TranslateNS<'agent-enhancer'> = key => translations[key] ?? key

  it('includes stage, elapsed seconds, and byte progress', () => {
    const line = formatSkillInstallProgressLine(
      {
        sessionId: 's',
        stage: 'downloading',
        detail: 'owner/repo',
        bytesReceived: 1536,
        bytesTotal: 4096,
        startedAt: 1_000,
      },
      4_000,
      t,
    )
    expect(line).toContain('Downloading repo')
    expect(line).toContain('3s elapsed')
    expect(line).toContain('1.5 KB / 4.0 KB')
  })

  it('shows clone percent instead of byte sizes', () => {
    const line = formatSkillInstallProgressLine(
      {
        sessionId: 's',
        stage: 'cloning',
        detail: 'owner/repo',
        bytesReceived: 67,
        bytesTotal: 100,
        startedAt: 1_000,
      },
      4_000,
      t,
    )
    expect(line).toContain('Cloning repo')
    expect(line).toContain('67%')
  })
})
