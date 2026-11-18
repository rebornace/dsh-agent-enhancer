import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceAgentsFile, createWorkspaceSkill, skillStubMarkdown } from '../src/host/instructions-skills/create.ts'
import {
  discoverFilesystemSkills,
  discoverInstructionFiles,
  mergeSkillCatalogs,
  normalizeRegistrySkills,
} from '../src/host/instructions-skills/discover.ts'
import { skillDocumentAbsolutePath } from '../src/host/instructions-skills/io.ts'
import { isKebabCaseName } from '../src/host/instructions-skills/paths.ts'
import { AuxiliaryError } from '../src/errors.ts'

const temps: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('instructions-skills paths', () => {
  it('accepts kebab-case skill names only', () => {
    expect(isKebabCaseName('my-skill')).toBe(true)
    expect(isKebabCaseName('a')).toBe(true)
    expect(isKebabCaseName('My-Skill')).toBe(false)
    expect(isKebabCaseName('-bad')).toBe(false)
    expect(isKebabCaseName('bad_name')).toBe(false)
  })

  it('resolves skill folders to SKILL.md for in-panel preview', () => {
    expect(skillDocumentAbsolutePath('/home/.agents/skills/demo')).toMatch(/SKILL\.md$/i)
    expect(skillDocumentAbsolutePath('/home/.agents/skills/demo/SKILL.md')).toMatch(/SKILL\.md$/i)
  })
})

describe('instructions-skills discovery', () => {
  it('lists global, shared, and project AGENTS.md candidates', () => {
    const home = tempDir('ae-is-home-')
    const agents = tempDir('ae-is-agents-')
    const project = tempDir('ae-is-proj-')
    mkdirSync(join(project, '.git'))
    writeFileSync(join(home, 'AGENTS.md'), '# global\n', 'utf8')
    writeFileSync(join(project, 'AGENTS.md'), '# project\n', 'utf8')
    writeFileSync(join(project, 'CLAUDE.md'), '# claude\n', 'utf8')

    const discovered = discoverInstructionFiles({
      cwd: project,
      env: {
        DSH_HOME: home,
        DSH_AGENTS_HOME: agents,
      },
    })

    expect(discovered.projectRoot).toBe(project)
    expect(discovered.instructions.map(entry => [entry.scope, entry.name, entry.exists])).toEqual([
      ['global', 'AGENTS.md', true],
      ['shared', 'AGENTS.md', false],
      ['project', 'AGENTS.md', true],
      ['project', 'CLAUDE.md', true],
    ])
    expect(discovered.instructions.find(entry => entry.name === 'AGENTS.md' && entry.scope === 'project')?.createable)
      .toBe(false)
  })

  it('discovers filesystem skills with frontmatter description', () => {
    const home = tempDir('ae-is-skill-home-')
    const agents = tempDir('ae-is-skill-agents-')
    const project = tempDir('ae-is-skill-proj-')
    mkdirSync(join(project, '.git'))
    const skillDir = join(project, '.agents', 'skills', 'demo-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: demo-skill
description: "Demo workflow"
---

# Demo
`, 'utf8')
    const dshSkillDir = join(project, '.dsh', 'skills', 'legacy-skill')
    mkdirSync(dshSkillDir, { recursive: true })
    writeFileSync(join(dshSkillDir, 'SKILL.md'), `---
name: legacy-skill
description: From .dsh/skills
---

# Legacy
`, 'utf8')

    const skills = discoverFilesystemSkills({
      cwd: project,
      projectRoot: project,
      env: { DSH_HOME: home, DSH_AGENTS_HOME: agents },
    })
    // previewSkillSearchRoots also scans the real user home (Cursor/Codex/Claude);
    // assert project-scoped entries specifically so the test is machine-independent.
    const projectSkills = skills.filter(
      entry => entry.provider === 'project' || entry.provider === 'project-dsh',
    )
    expect(projectSkills.map(entry => entry.name).sort()).toEqual(['demo-skill', 'legacy-skill'])
    expect(projectSkills.find(entry => entry.name === 'demo-skill')).toMatchObject({
      description: 'Demo workflow',
      provider: 'project',
    })
    expect(projectSkills.find(entry => entry.name === 'legacy-skill')).toMatchObject({
      description: 'From .dsh/skills',
      provider: 'project-dsh',
    })
  })

  it('normalizes registry skill catalogs', () => {
    expect(normalizeRegistrySkills({
      skills: [
        { name: 'alpha', description: 'A', path: '/tmp/a/SKILL.md', provider: 'runtime', modelInvocable: true },
        { name: 'alpha', description: 'dup' },
        { name: ' beta ', description: 'B' },
      ],
    })?.map(entry => entry.name)).toEqual(['alpha', 'beta'])
  })

  it('merges filesystem skills over a stale/empty registry', () => {
    const filesystem = [
      {
        id: 'fs:a',
        name: 'academic-writing',
        description: 'From disk',
        path: 'C:/Users/x/.agents/skills/academic-writing/SKILL.md',
        provider: 'shared',
        modelInvocable: null,
        userInvocable: null,
        removable: true,
        installChannel: null,
        updateAvailable: false,
        updateSourceLabel: null,
        updateCheckFailed: false,
      },
    ]
    const empty = mergeSkillCatalogs(filesystem, [])
    expect(empty.source).toBe('merged')
    expect(empty.skills.map(entry => entry.name)).toEqual(['academic-writing'])

    const stale = mergeSkillCatalogs(filesystem, [
      {
        id: 'reg:old',
        name: 'other-skill',
        description: 'Registry only',
        path: null,
        provider: 'registry',
        modelInvocable: true,
        userInvocable: true,
        removable: false,
        installChannel: null,
        updateAvailable: false,
        updateSourceLabel: null,
        updateCheckFailed: false,
      },
    ])
    expect(stale.skills.map(entry => entry.name)).toEqual(['academic-writing', 'other-skill'])
    expect(stale.skills.find(entry => entry.name === 'academic-writing')?.description).toBe('From disk')
    expect(stale.skills.find(entry => entry.name === 'academic-writing')?.removable).toBe(true)
    expect(stale.skills.find(entry => entry.name === 'other-skill')?.removable).toBe(false)
  })
})

describe('instructions-skills create', () => {
  it('writes AGENTS.md and skill stubs without overwrite', () => {
    const project = tempDir('ae-is-create-')
    const agents = createWorkspaceAgentsFile(project)
    expect(agents.created).toBe(true)
    expect(readFileSync(agents.path, 'utf8')).toContain('# Agent notes')
    expect(() => createWorkspaceAgentsFile(project)).toThrow(AuxiliaryError)

    const skill = createWorkspaceSkill(project, 'my-workflow')
    expect(skill.path).toBe(join(project, '.agents', 'skills', 'my-workflow', 'SKILL.md'))
    expect(readFileSync(skill.path, 'utf8')).toBe(skillStubMarkdown('my-workflow'))
    expect(() => createWorkspaceSkill(project, 'my-workflow')).toThrow(AuxiliaryError)
    expect(() => createWorkspaceSkill(project, 'Bad Name')).toThrow(AuxiliaryError)
  })
})
