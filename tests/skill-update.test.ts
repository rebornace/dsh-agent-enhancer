import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuxiliaryError } from '../src/errors.ts'
import { contentRevisionOfDir } from '../src/host/instructions-skills/content-revision.ts'
import { enrichSkillsFromLedger, updateSkillFromGitNow } from '../src/host/instructions-skills/io.ts'
import {
  readInstallLedger,
  upsertInstallRecord,
  type SkillInstallRecord,
} from '../src/host/instructions-skills/install-ledger.ts'
import { installSkillsFromGit } from '../src/host/instructions-skills/install.ts'
import { defaultSkillInstallMeta } from '../src/host/instructions-skills/types.ts'
import * as updateCheck from '../src/host/instructions-skills/update-check.ts'
import { checkGithubSkillUpdate, resolveUpdateFlag } from '../src/host/instructions-skills/update-check.ts'

const temps: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()
    if (dir === undefined) continue
    try {
      // git leaves pack/index files open on Windows; retry instead of failing teardown.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch { /* a locked temp dir is not a test failure */ }
  }
})

function githubRecord(overrides: Partial<SkillInstallRecord> & Pick<SkillInstallRecord, 'name'>): SkillInstallRecord {
  return {
    channel: 'github',
    source: 'local/fixture',
    contentRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    installedAt: '2026-11-07T00:00:00.000Z',
    updateCheck: true,
    ...overrides,
  }
}

describe('checkGithubSkillUpdate', () => {
  it('marks updateAvailable when remote tree revision differs', async () => {
    const repo = join(tempDir('ae-skill-upd-parent-'), 'fixture.git')
    mkdirSync(repo, { recursive: true })
    const skill = join(repo, 'skills', 'upd-skill')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\ndescription: One\n---\n# One\n', 'utf8')
    execFileSync('git', ['init'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['config', 'user.email', 'ae@test.local'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['config', 'user.name', 'ae'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, windowsHide: true })

    const source = pathToFileURL(repo).href
    const agents = tempDir('ae-skill-upd-agents-')
    const project = tempDir('ae-skill-upd-proj-')
    mkdirSync(join(project, '.git'))
    const ledgerRoot = tempDir('ae-skill-upd-ledger-')
    await installSkillsFromGit({
      source,
      target: 'user',
      projectRoot: project,
      force: false,
      env: { DSH_AGENTS_HOME: agents, DSH_HOME: tempDir('ae-skill-upd-dsh-') },
      signal: new AbortController().signal,
      installLedgerRoot: ledgerRoot,
    })
    const skillPath = join(agents, 'skills', 'upd-skill')
    const record = githubRecord({
      name: 'upd-skill',
      source,
      contentRevision: contentRevisionOfDir(skillPath),
    })

    const same = await checkGithubSkillUpdate(record)
    expect(same.updateAvailable).toBe(false)
    expect(same.updateCheckFailed).toBe(false)

    writeFileSync(join(skill, 'SKILL.md'), '---\ndescription: Two\n---\n# Two\n', 'utf8')
    execFileSync('git', ['add', join(skill, 'SKILL.md')], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'bump'], { cwd: repo, windowsHide: true })

    const changed = await checkGithubSkillUpdate(record)
    expect(changed.updateAvailable).toBe(true)
    expect(changed.updateCheckFailed).toBe(false)
    expect(changed.updateSourceLabel).toContain('fixture')
  }, 30_000)

  it('sets updateCheckFailed when the remote source cannot be materialized', async () => {
    const record = githubRecord({
      name: 'ghost-skill',
      source: pathToFileURL(join(tempDir('ae-skill-upd-miss-'), 'no-repo.git')).href,
      contentRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })
    const failed = await checkGithubSkillUpdate(record)
    expect(failed.updateAvailable).toBe(false)
    expect(failed.updateCheckFailed).toBe(true)
  })

  it('never marks zip records updateAvailable', async () => {
    const zipRecord: SkillInstallRecord = {
      name: 'zip-skill',
      channel: 'zip',
      source: null,
      contentRevision: null,
      installedAt: '2026-11-07T00:00:00.000Z',
      updateCheck: false,
    }
    expect(await resolveUpdateFlag(zipRecord)).toBe(false)
    const zipCheck = await checkGithubSkillUpdate(zipRecord)
    expect(zipCheck.updateAvailable).toBe(false)
    expect(zipCheck.updateCheckFailed).toBe(false)
  })

  it('cleans up temp workdirs after check', async () => {
    const repo = join(tempDir('ae-skill-upd2-parent-'), 'fixture.git')
    mkdirSync(repo, { recursive: true })
    const skill = join(repo, 'skills', 'temp-clean')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\ndescription: x\n---\n', 'utf8')
    execFileSync('git', ['init'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['config', 'user.email', 'ae@test.local'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['config', 'user.name', 'ae'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, windowsHide: true })

    const source = pathToFileURL(repo).href
    const agents = tempDir('ae-skill-upd2-agents-')
    const project = tempDir('ae-skill-upd2-proj-')
    mkdirSync(join(project, '.git'))
    await installSkillsFromGit({
      source,
      target: 'user',
      projectRoot: project,
      force: false,
      env: { DSH_AGENTS_HOME: agents, DSH_HOME: tempDir('ae-skill-upd2-dsh-') },
      signal: new AbortController().signal,
    })
    const skillPath = join(agents, 'skills', 'temp-clean')
    const record = githubRecord({
      name: 'temp-clean',
      source,
      contentRevision: contentRevisionOfDir(skillPath),
    })

    const before = new Set(readDirNames(tmpdir(), 'ae-skill-update-'))
    await checkGithubSkillUpdate(record)
    const after = new Set(readDirNames(tmpdir(), 'ae-skill-update-'))
    expect(after.size).toBe(before.size)
  })
})

describe('enrichSkillsFromLedger', () => {
  it('keeps the full catalog when checkGithubSkillUpdate throws', async () => {
    const ledgerRoot = tempDir('ae-enrich-ledger-')
    upsertInstallRecord(ledgerRoot, {
      name: 'ledger-skill',
      channel: 'github',
      source: 'acme/widgets',
      contentRevision: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      installedAt: '2026-11-07T00:00:00.000Z',
      updateCheck: true,
    })
    const base = {
      description: '',
      path: null,
      provider: 'shared',
      modelInvocable: null,
      userInvocable: null,
      removable: true,
      ...defaultSkillInstallMeta(),
    }
    const skills = [
      { id: 'fs:a', name: 'ledger-skill', ...base },
      { id: 'fs:b', name: 'other-skill', ...base },
    ]
    const spy = vi.spyOn(updateCheck, 'checkGithubSkillUpdate')
      .mockRejectedValueOnce(new Error('network down'))
    const enriched = await enrichSkillsFromLedger(skills, {
      installLedgerRoot: ledgerRoot,
      signal: new AbortController().signal,
      checkUpdates: true,
    })
    spy.mockRestore()
    expect(enriched).toHaveLength(2)
    expect(enriched.map(entry => entry.name)).toEqual(['ledger-skill', 'other-skill'])
    expect(enriched.find(entry => entry.name === 'ledger-skill')).toMatchObject({
      installChannel: 'github',
      updateAvailable: false,
      updateCheckFailed: true,
    })
    expect(enriched.find(entry => entry.name === 'other-skill')?.updateCheckFailed).toBe(false)
  })

  it('skips network update checks unless checkUpdates is true', async () => {
    const ledgerRoot = tempDir('ae-enrich-nocheck-')
    upsertInstallRecord(ledgerRoot, {
      name: 'ledger-skill',
      channel: 'github',
      source: 'acme/widgets',
      contentRevision: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      installedAt: '2026-11-07T00:00:00.000Z',
      updateCheck: true,
    })
    const skills = [{
      id: 'fs:a',
      name: 'ledger-skill',
      description: '',
      path: null,
      provider: 'shared',
      modelInvocable: null,
      userInvocable: null,
      removable: true,
      ...defaultSkillInstallMeta(),
    }]
    const spy = vi.spyOn(updateCheck, 'checkGithubSkillUpdate')
    const enriched = await enrichSkillsFromLedger(skills, {
      installLedgerRoot: ledgerRoot,
      signal: new AbortController().signal,
    })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    expect(enriched[0]).toMatchObject({
      installChannel: 'github',
      updateAvailable: false,
      updateCheckFailed: false,
      updateSourceLabel: 'acme/widgets',
    })
  })

  it('maps updateCheckFailed from checkGithubSkillUpdate result', async () => {
    const ledgerRoot = tempDir('ae-enrich-ledger2-')
    upsertInstallRecord(ledgerRoot, {
      name: 'ledger-skill',
      channel: 'github',
      source: 'acme/widgets',
      contentRevision: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      installedAt: '2026-11-07T00:00:00.000Z',
      updateCheck: true,
    })
    const skills = [{
      id: 'fs:a',
      name: 'ledger-skill',
      description: '',
      path: null,
      provider: 'shared',
      modelInvocable: null,
      userInvocable: null,
      removable: true,
      ...defaultSkillInstallMeta(),
    }]
    const spy = vi.spyOn(updateCheck, 'checkGithubSkillUpdate')
      .mockResolvedValueOnce({
        updateAvailable: false,
        updateSourceLabel: 'acme/widgets',
        updateCheckFailed: true,
      })
    const enriched = await enrichSkillsFromLedger(skills, {
      installLedgerRoot: ledgerRoot,
      signal: new AbortController().signal,
      checkUpdates: true,
    })
    spy.mockRestore()
    expect(enriched[0]).toMatchObject({
      updateAvailable: false,
      updateCheckFailed: true,
      updateSourceLabel: 'acme/widgets',
    })
  })
})

function mockSessionCtx(cwd: string, sessionId: SessionId): Context {
  return {
    agents: {
      get: (id: SessionId) => (id === sessionId ? { session: { header: { cwd } } } : undefined),
    },
    get: () => undefined,
  } as unknown as Context
}

describe('updateSkillFromGitNow', () => {
  const sessionId = 'session-update-1' as SessionId

  it('rejects zip ledger records and missing git sources', async () => {
    const ledgerRoot = tempDir('ae-update-reject-ledger-')
    const project = tempDir('ae-update-reject-proj-')
    mkdirSync(join(project, '.git'))
    upsertInstallRecord(ledgerRoot, {
      name: 'zip-only',
      channel: 'zip',
      source: null,
      contentRevision: null,
      installedAt: '2026-11-07T00:00:00.000Z',
      updateCheck: false,
    })
    upsertInstallRecord(ledgerRoot, {
      name: 'no-source',
      channel: 'github',
      source: null,
      contentRevision: 'eee',
      installedAt: '2026-11-07T00:00:00.000Z',
      updateCheck: true,
    })
    const ctx = mockSessionCtx(project, sessionId)
    const signal = new AbortController().signal
    await expect(updateSkillFromGitNow({
      ctx,
      request: { sessionId, name: 'zip-only' },
      signal,
      installLedgerRoot: ledgerRoot,
    })).rejects.toBeInstanceOf(AuxiliaryError)
    await expect(updateSkillFromGitNow({
      ctx,
      request: { sessionId, name: 'no-source' },
      signal,
      installLedgerRoot: ledgerRoot,
    })).rejects.toMatchObject({ code: 'FILE_DENIED' })
  })

  it('force reinstalls from ledger source and refreshes ledger revision', async () => {
    const repo = join(tempDir('ae-update-pull-parent-'), 'fixture.git')
    mkdirSync(repo, { recursive: true })
    const skill = join(repo, 'skills', 'pull-skill')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\ndescription: v1\n---\n# v1\n', 'utf8')
    execFileSync('git', ['init'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['config', 'user.email', 'ae@test.local'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['config', 'user.name', 'ae'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, windowsHide: true })

    const source = pathToFileURL(repo).href
    const agents = tempDir('ae-update-pull-agents-')
    const project = tempDir('ae-update-pull-proj-')
    mkdirSync(join(project, '.git'))
    const ledgerRoot = tempDir('ae-update-pull-ledger-')
    await installSkillsFromGit({
      source,
      target: 'user',
      projectRoot: project,
      force: false,
      env: { DSH_AGENTS_HOME: agents, DSH_HOME: tempDir('ae-update-pull-dsh-') },
      signal: new AbortController().signal,
      installLedgerRoot: ledgerRoot,
    })
    const before = readInstallLedger(ledgerRoot)['pull-skill']?.contentRevision

    writeFileSync(join(skill, 'SKILL.md'), '---\ndescription: v2\n---\n# v2\n', 'utf8')
    execFileSync('git', ['add', join(skill, 'SKILL.md')], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'v2'], { cwd: repo, windowsHide: true })

    const skillPath = join(agents, 'skills', 'pull-skill')
    const prevAgentsHome = process.env.DSH_AGENTS_HOME
    process.env.DSH_AGENTS_HOME = agents
    let result
    try {
      result = await updateSkillFromGitNow({
        ctx: mockSessionCtx(project, sessionId),
        request: { sessionId, name: 'pull-skill' },
        signal: new AbortController().signal,
        installLedgerRoot: ledgerRoot,
      })
    } finally {
      if (prevAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
      else process.env.DSH_AGENTS_HOME = prevAgentsHome
    }
    expect(result.updated.name).toBe('pull-skill')
    expect(readFileSync(join(skillPath, 'SKILL.md'), 'utf8')).toContain('v2')
    const after = readInstallLedger(ledgerRoot)['pull-skill']?.contentRevision
    expect(after).not.toBe(before)
    expect(after).toBe(contentRevisionOfDir(skillPath))
    expect(result.snapshot.skills.find(entry => entry.name === 'pull-skill')).toMatchObject({
      installChannel: 'github',
      updateAvailable: false,
      updateCheckFailed: false,
    })
  }, 30_000)
})

function readDirNames(root: string, prefix: string): string[] {
  try {
    return readdirSync(root).filter(name => name.startsWith(prefix))
  } catch {
    return []
  }
}
