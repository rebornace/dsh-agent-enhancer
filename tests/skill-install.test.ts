import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuxiliaryError } from '../src/errors.ts'
import { parseGitSkillSource } from '../src/host/instructions-skills/git-source.ts'
import { unwrapArchiveRoot } from '../src/host/instructions-skills/github-archive.ts'
import {
  findSkillBundles,
  installBundle,
  installTargetDir,
  resolveBundlesFromClone,
} from '../src/host/instructions-skills/install-fs.ts'
import {
  installSkillFromLocalPath,
  installSkillsFromGit,
} from '../src/host/instructions-skills/install.ts'
import { readInstallLedger, upsertInstallRecord } from '../src/host/instructions-skills/install-ledger.ts'
import { contentRevisionOfDir } from '../src/host/instructions-skills/content-revision.ts'
import { installSkillsFromZipFile } from '../src/host/instructions-skills/zip-install.ts'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  isGithubRepoNotFound,
  isHostStaleTransport,
  isNetworkInstallFailure,
} from '../src/client/instructions-skills/errors.ts'
import { skillScopeBucket } from '../src/host/instructions-skills/scope.ts'
import {
  isProtectedExternalSkillPath,
  removePathRobust,
} from '../src/host/instructions-skills/remove-path.ts'
import {
  purgeManagedSkillName,
  uninstallManagedSkill,
} from '../src/host/instructions-skills/uninstall.ts'

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
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch { /* a locked temp dir is not a test failure */ }
  }
})

describe('parseGitSkillSource', () => {
  it('parses owner/repo and nested paths', () => {
    expect(parseGitSkillSource('acme/widgets')).toEqual({
      cloneUrl: 'https://github.com/acme/widgets.git',
      subpath: null,
      label: 'acme/widgets',
      github: { owner: 'acme', repo: 'widgets' },
    })
    expect(parseGitSkillSource('acme/widgets/skills/deploy-app')).toEqual({
      cloneUrl: 'https://github.com/acme/widgets.git',
      subpath: 'skills/deploy-app',
      label: 'acme/widgets/skills/deploy-app',
      github: { owner: 'acme', repo: 'widgets' },
    })
  })

  it('parses GitHub HTTPS tree URLs', () => {
    expect(parseGitSkillSource('https://github.com/acme/widgets/tree/main/skills/foo')).toEqual({
      cloneUrl: 'https://github.com/acme/widgets.git',
      subpath: 'skills/foo',
      label: 'acme/widgets/skills/foo',
      github: { owner: 'acme', repo: 'widgets' },
    })
  })
})

describe('unwrapArchiveRoot', () => {
  it('returns the single top-level folder from a zipball layout', () => {
    const root = tempDir('ae-zip-root-')
    mkdirSync(join(root, 'repo-main'), { recursive: true })
    writeFileSync(join(root, 'repo-main', 'SKILL.md'), '# x\n', 'utf8')
    expect(unwrapArchiveRoot(root)).toBe(join(root, 'repo-main'))
  })
})

describe('skill install filesystem', () => {
  it('finds directory and flat skill bundles', () => {
    const root = tempDir('ae-skill-find-')
    mkdirSync(join(root, 'demo-skill'), { recursive: true })
    writeFileSync(join(root, 'demo-skill', 'SKILL.md'), '---\ndescription: Demo\n---\n# Demo\n', 'utf8')
    writeFileSync(join(root, 'flat-skill.md'), '---\ndescription: Flat\n---\n# Flat\n', 'utf8')
    expect(findSkillBundles(root).map(entry => entry.name)).toEqual(['demo-skill', 'flat-skill'])
  })

  it('maps install targets to agents and dsh skill roots', () => {
    const project = tempDir('ae-skill-target-proj-')
    const agents = tempDir('ae-skill-target-agents-')
    const dsh = tempDir('ae-skill-target-dsh-')
    expect(installTargetDir('user', project, agents, dsh)).toBe(join(agents, 'skills'))
    expect(installTargetDir('user-dsh', project, agents, dsh)).toBe(join(dsh, 'skills'))
    expect(installTargetDir('project', project, agents, dsh)).toBe(join(project, '.agents', 'skills'))
    expect(installTargetDir('project-dsh', project, agents, dsh)).toBe(join(project, '.dsh', 'skills'))
  })

  it('resolves clone layouts and installs by copy without overwrite', () => {
    const clone = tempDir('ae-skill-clone-')
    const skills = join(clone, 'skills', 'ship-it')
    mkdirSync(skills, { recursive: true })
    writeFileSync(join(skills, 'SKILL.md'), '---\ndescription: Ship\n---\n# Ship\n', 'utf8')
    expect(resolveBundlesFromClone(clone, null).map(entry => entry.name)).toEqual(['ship-it'])

    const project = tempDir('ae-skill-proj-')
    const agents = tempDir('ae-skill-agents-')
    const targetDir = installTargetDir('user', project, agents, join(tempDir('ae-skill-dsh-home-'), 'dsh'))
    const [bundle] = resolveBundlesFromClone(clone, null)
    const installed = installBundle({ bundle: bundle!, targetDir, force: false, mode: 'copy' })
    expect(existsSync(join(installed.path, 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(installed.path, 'SKILL.md'), 'utf8')).toContain('Ship')
    expect(() => installBundle({ bundle: bundle!, targetDir, force: false, mode: 'copy' }))
      .toThrow(AuxiliaryError)
  })

  it('links local skills into the user target', () => {
    const library = tempDir('ae-skill-lib-')
    const skill = join(library, 'local-flow')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\ndescription: Local\n---\n# Local\n', 'utf8')
    const project = tempDir('ae-skill-proj2-')
    const agents = tempDir('ae-skill-agents2-')
    const installed = installSkillFromLocalPath({
      sourcePath: skill,
      target: 'user',
      projectRoot: project,
      force: false,
      mode: 'link',
      env: { DSH_AGENTS_HOME: agents, DSH_HOME: tempDir('ae-skill-dsh-') },
    })
    expect(installed.name).toBe('local-flow')
    expect(existsSync(join(installed.path, 'SKILL.md'))).toBe(true)
  })

  it('installs skills from a local zip archive', async () => {
    const pack = tempDir('ae-skill-zip-src-')
    const skill = join(pack, 'zip-skill')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\ndescription: From zip\n---\n# Zip\n', 'utf8')
    const zipDir = tempDir('ae-skill-zip-out-')
    const zipPath = join(zipDir, 'pack.zip')
    execFileSync('tar', ['-a', '-cf', zipPath, '-C', pack, '.'], { windowsHide: true })

    const agents = tempDir('ae-skill-zip-agents-')
    const project = tempDir('ae-skill-zip-proj-')
    mkdirSync(join(project, '.git'))
    const ledgerRoot = tempDir('ae-skill-zip-ledger-')
    const installed = await installSkillsFromZipFile({
      zipPath,
      target: 'user',
      projectRoot: project,
      force: false,
      env: { DSH_AGENTS_HOME: agents, DSH_HOME: tempDir('ae-skill-zip-dsh-') },
      signal: new AbortController().signal,
      installLedgerRoot: ledgerRoot,
    })
    expect(installed.map(entry => entry.name)).toEqual(['zip-skill'])
    expect(existsSync(join(agents, 'skills', 'zip-skill', 'SKILL.md'))).toBe(true)
    const zipRecord = readInstallLedger(ledgerRoot)['zip-skill']
    expect(zipRecord?.channel).toBe('zip')
    expect(zipRecord?.source).toBeNull()
    expect(zipRecord?.contentRevision).toBeNull()
    expect(zipRecord?.updateCheck).toBe(false)
  })

  it('records github channel in install ledger after git install', async () => {
    const repo = join(tempDir('ae-skill-git-parent-'), 'fixture.git')
    mkdirSync(repo, { recursive: true })
    const skill = join(repo, 'skills', 'git-skill')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\ndescription: Git\n---\n# Git\n', 'utf8')
    execFileSync('git', ['init'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['config', 'user.email', 'ae@test.local'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['config', 'user.name', 'ae'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, windowsHide: true })

    const source = pathToFileURL(repo).href
    const agents = tempDir('ae-skill-git-agents-')
    const project = tempDir('ae-skill-git-proj-')
    mkdirSync(join(project, '.git'))
    const ledgerRoot = tempDir('ae-skill-git-ledger-')
    const batch = await installSkillsFromGit({
      source,
      target: 'user',
      projectRoot: project,
      force: false,
      env: { DSH_AGENTS_HOME: agents, DSH_HOME: tempDir('ae-skill-git-dsh-') },
      signal: new AbortController().signal,
      installLedgerRoot: ledgerRoot,
    })
    expect(batch.installed.map(entry => entry.name)).toEqual(['git-skill'])
    expect(batch.skippedBusy).toEqual([])
    const skillPath = join(agents, 'skills', 'git-skill')
    const ledger = readInstallLedger(ledgerRoot)
    expect(ledger['git-skill']?.channel).toBe('github')
    expect(ledger['git-skill']?.source).toBe(source)
    expect(ledger['git-skill']?.contentRevision).toBe(contentRevisionOfDir(skillPath))
    expect(ledger['git-skill']?.updateCheck).toBe(true)
  }, 30_000)

  it('uninstalls managed user skills and refuses paths outside roots', () => {
    const agents = tempDir('ae-skill-un-agents-')
    const project = tempDir('ae-skill-un-proj-')
    mkdirSync(join(project, '.git'))
    const skillDir = join(agents, 'skills', 'drop-me')
    mkdirSync(skillDir, { recursive: true })
    const skillMd = join(skillDir, 'SKILL.md')
    writeFileSync(skillMd, '---\ndescription: Drop\n---\n', 'utf8')

    const ledgerRoot = tempDir('ae-skill-un-ledger-')
    upsertInstallRecord(ledgerRoot, {
      name: 'drop-me',
      channel: 'github',
      source: 'acme/skills',
      contentRevision: 'deadbeef',
      installedAt: '2026-11-07T00:00:00.000Z',
      updateCheck: true,
    })

    const removed = uninstallManagedSkill({
      name: 'drop-me',
      path: skillMd,
      cwd: project,
      projectRoot: project,
      env: { DSH_AGENTS_HOME: agents, DSH_HOME: tempDir('ae-skill-un-dsh-') },
      installLedgerRoot: ledgerRoot,
    })
    expect(readInstallLedger(ledgerRoot)['drop-me']).toBeUndefined()
    expect(removed.name).toBe('drop-me')
    expect(existsSync(skillDir)).toBe(false)

    expect(() => uninstallManagedSkill({
      name: 'drop-me',
      path: join(project, 'not-managed', 'drop-me', 'SKILL.md'),
      cwd: project,
      projectRoot: project,
      env: { DSH_AGENTS_HOME: agents, DSH_HOME: tempDir('ae-skill-un-dsh2-') },
    })).toThrow(AuxiliaryError)
  })

  it('removePathRobust deletes a nested skill tree', () => {
    const root = tempDir('ae-skill-rm-')
    const skill = join(root, 'nested-skill')
    mkdirSync(join(skill, 'docs'), { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: nested-skill\n---\n', 'utf8')
    writeFileSync(join(skill, 'docs', 'note.txt'), 'hi', 'utf8')
    removePathRobust(skill)
    expect(existsSync(skill)).toBe(false)
  })

  it('uninstall clears the same name from every managed root', () => {
    const agents = tempDir('ae-skill-dual-agents-')
    const dsh = tempDir('ae-skill-dual-dsh-')
    const project = tempDir('ae-skill-dual-proj-')
    mkdirSync(join(project, '.git'))

    const agentsSkill = join(agents, 'skills', 'dual-skill')
    mkdirSync(agentsSkill, { recursive: true })
    writeFileSync(join(agentsSkill, 'SKILL.md'), '---\ndescription: Agents copy\n---\n', 'utf8')

    const dshSkill = join(dsh, 'skills', 'dual-skill')
    mkdirSync(dshSkill, { recursive: true })
    writeFileSync(join(dshSkill, 'SKILL.md'), '---\ndescription: Dsh copy\n---\n', 'utf8')

    uninstallManagedSkill({
      name: 'dual-skill',
      path: join(agentsSkill, 'SKILL.md'),
      cwd: project,
      projectRoot: project,
      env: { DSH_AGENTS_HOME: agents, DSH_HOME: dsh },
    })

    expect(existsSync(agentsSkill)).toBe(false)
    expect(existsSync(dshSkill)).toBe(false)
  })

  it('prefers SKILL.md frontmatter name over archive folder basename', () => {
    const archive = tempDir('ae-skill-fm-archive-')
    const folder = join(archive, 'skills-widgets-master-e394039efa6c78a353ffd6f238a3d158b10f8217')
    mkdirSync(folder, { recursive: true })
    writeFileSync(
      join(folder, 'SKILL.md'),
      '---\nname: widgets\ndescription: Widgets\n---\n# Widgets\n',
      'utf8',
    )
    expect(resolveBundlesFromClone(archive, null).map(entry => entry.name)).toEqual(['widgets'])
  })

  it('force install overwrites an existing skill destination', () => {
    const clone = tempDir('ae-skill-ow-src-')
    const skill = join(clone, 'ow-skill')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\ndescription: New\n---\n# New\n', 'utf8')
    const [bundle] = resolveBundlesFromClone(clone, null)

    const targetDir = join(tempDir('ae-skill-ow-agents-'), 'skills')
    const existing = join(targetDir, 'ow-skill')
    mkdirSync(existing, { recursive: true })
    writeFileSync(join(existing, 'SKILL.md'), '---\ndescription: Old\n---\n# Old\n', 'utf8')

    const installed = installBundle({
      bundle: bundle!,
      targetDir,
      force: true,
      mode: 'copy',
    })
    expect(readFileSync(join(installed.path, 'SKILL.md'), 'utf8')).toContain('New')
    expect(readFileSync(join(installed.path, 'SKILL.md'), 'utf8')).not.toContain('# Old')
  })

  it('reinstalls over a stale empty destination without force', () => {
    const clone = tempDir('ae-skill-stale-src-')
    const skill = join(clone, 'revive-me')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\ndescription: Revive\n---\n# Revive\n', 'utf8')
    const [bundle] = resolveBundlesFromClone(clone, null)

    const targetDir = join(tempDir('ae-skill-stale-agents-'), 'skills')
    const stale = join(targetDir, 'revive-me')
    mkdirSync(stale, { recursive: true })
    expect(existsSync(join(stale, 'SKILL.md'))).toBe(false)

    const installed = installBundle({
      bundle: bundle!,
      targetDir,
      force: false,
      mode: 'copy',
    })
    expect(installed.name).toBe('revive-me')
    expect(existsSync(join(installed.path, 'SKILL.md'))).toBe(true)
  })

  it('maps providers into installed scope buckets', () => {
    expect(skillScopeBucket('shared')).toBe('user')
    expect(skillScopeBucket('dsh-home')).toBe('user')
    expect(skillScopeBucket('project')).toBe('project')
    expect(skillScopeBucket('registry')).toBe('other')
  })

  it('does not treat GitHub HTTP 404 as a stale host transport', () => {
    const github404 = new AuxiliaryError(
      'FILE_NOT_FOUND',
      'GitHub repository not found: acme/widgets',
    )
    expect(isGithubRepoNotFound(github404)).toBe(true)
    expect(isHostStaleTransport(github404)).toBe(false)

    const archive404 = new Error(
      'GitHub archive download failed for acme/widgets. https://api.github.com/repos/acme/widgets/zipball: HTTP 404',
    )
    expect(isGithubRepoNotFound(archive404)).toBe(true)
    expect(isHostStaleTransport(archive404)).toBe(false)

    const stale = new Error('installSkillFromGit remote is unavailable')
    expect(isHostStaleTransport(stale)).toBe(true)
  })

  it('maps proxy/gateway failures to network, not repo-not-found', () => {
    const gateway = new Error(
      'git clone failed: repository not found. Archive fallback also failed: HTTP 504 from https://api.github.com/repos/obra/superpowers/zipball',
    )
    expect(isNetworkInstallFailure(gateway)).toBe(true)
    expect(isGithubRepoNotFound(gateway)).toBe(false)
  })

  it('removePathRobust unlinks a junction without deleting the target tree', () => {
    const root = tempDir('ae-skill-junc-')
    const central = join(root, 'skills-manager', 'keep-me')
    const agentsLink = join(root, 'agents', 'keep-me')
    mkdirSync(central, { recursive: true })
    writeFileSync(join(central, 'SKILL.md'), '---\nname: keep-me\n---\ncentral\n', 'utf8')
    writeFileSync(join(central, 'extra.txt'), 'preserve', 'utf8')
    mkdirSync(join(root, 'agents'), { recursive: true })
    symlinkSync(central, agentsLink, process.platform === 'win32' ? 'junction' : 'dir')
    expect(lstatSync(agentsLink).isSymbolicLink()).toBe(true)

    removePathRobust(agentsLink)

    expect(existsSync(agentsLink)).toBe(false)
    expect(existsSync(join(central, 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(central, 'extra.txt'), 'utf8')).toBe('preserve')
  })

  it('force install over a junction replaces the link and keeps the former target', () => {
    const clone = tempDir('ae-skill-junc-src-')
    const skill = join(clone, 'junc-skill')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: junc-skill\ndescription: New\n---\n# New\n', 'utf8')
    const [bundle] = resolveBundlesFromClone(clone, null)

    const root = tempDir('ae-skill-junc-ow-')
    const central = join(root, 'central', 'junc-skill')
    const targetDir = join(root, 'agents', 'skills')
    const existing = join(targetDir, 'junc-skill')
    mkdirSync(central, { recursive: true })
    writeFileSync(join(central, 'SKILL.md'), '---\nname: junc-skill\n---\ncentral\n', 'utf8')
    writeFileSync(join(central, 'marker.txt'), 'sm-central', 'utf8')
    mkdirSync(targetDir, { recursive: true })
    symlinkSync(central, existing, process.platform === 'win32' ? 'junction' : 'dir')

    const installed = installBundle({
      bundle: bundle!,
      targetDir,
      force: true,
      mode: 'copy',
    })

    expect(lstatSync(installed.path).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(installed.path, 'SKILL.md'), 'utf8')).toContain('# New')
    expect(existsSync(join(central, 'marker.txt'))).toBe(true)
    expect(readFileSync(join(central, 'SKILL.md'), 'utf8')).toContain('central')
  })

  it('purgeManagedSkillName can spare the path just installed', () => {
    const agents = tempDir('ae-skill-except-agents-')
    const dsh = tempDir('ae-skill-except-dsh-')
    const project = tempDir('ae-skill-except-proj-')
    mkdirSync(join(project, '.git'))

    const keep = join(agents, 'skills', 'kept-skill')
    const drop = join(dsh, 'skills', 'kept-skill')
    mkdirSync(keep, { recursive: true })
    mkdirSync(drop, { recursive: true })
    writeFileSync(join(keep, 'SKILL.md'), '---\n---\nkeep\n', 'utf8')
    writeFileSync(join(drop, 'SKILL.md'), '---\n---\ndrop\n', 'utf8')

    purgeManagedSkillName({
      name: 'kept-skill',
      cwd: project,
      projectRoot: project,
      env: { DSH_AGENTS_HOME: agents, DSH_HOME: dsh },
      exceptPaths: [keep],
    })

    expect(existsSync(keep)).toBe(true)
    expect(existsSync(drop)).toBe(false)
  })

  it('skips deletes under the skills-manager home store without FILE_DENIED', () => {
    const homeSm = join(homedir(), '.skills-manager', 'skills', 'nope')
    expect(isProtectedExternalSkillPath(homeSm)).toBe(true)
    expect(isProtectedExternalSkillPath(join(tempDir('ae-skill-unprot-'), 'skills', 'nope'))).toBe(false)
    // Managed agents paths stay deletable (junction mounts into SM are OK to unlink).
    expect(isProtectedExternalSkillPath(join(homedir(), '.agents', 'skills', 'any-skill'))).toBe(false)
    // Must not throw — post-install purge used to surface「没有权限访问该路径」.
    expect(() => removePathRobust(homeSm)).not.toThrow()
  })
})
