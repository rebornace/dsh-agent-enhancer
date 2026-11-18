import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverFilesystemSkills } from '../src/host/instructions-skills/discover.ts'
import {
  isTransientSkillEntryName,
  sweepTransientSkillEntries,
} from '../src/host/instructions-skills/transient-paths.ts'

const temps: string[] = []

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('transient skill paths', () => {
  it('detects in-place aside / staging names', () => {
    expect(isTransientSkillEntryName('demo-skill.__ae_removing_1_2')).toBe(true)
    expect(isTransientSkillEntryName('foo.__ae_installing_9_9')).toBe(true)
    expect(isTransientSkillEntryName('ae-skill-removing-foo-1-2')).toBe(true)
    expect(isTransientSkillEntryName('demo-skill')).toBe(false)
  })

  it('sweeps leftover aside dirs under a skills root', () => {
    const root = mkdtempSync(join(tmpdir(), 'ae-skills-root-'))
    temps.push(root)
    const keep = join(root, 'keep-me')
    const junk = join(root, 'keep-me.__ae_removing_1_2')
    mkdirSync(keep)
    mkdirSync(junk)
    writeFileSync(join(keep, 'SKILL.md'), '---\nname: keep-me\n---\n', 'utf8')
    writeFileSync(join(junk, 'SKILL.md'), '---\nname: keep-me\n---\n', 'utf8')
    sweepTransientSkillEntries(root)
    expect(existsSync(keep)).toBe(true)
    expect(existsSync(junk)).toBe(false)
  })

  it('does not list transient aside folders as skills', () => {
    const home = mkdtempSync(join(tmpdir(), 'ae-home-'))
    temps.push(home)
    const skills = join(home, '.agents', 'skills')
    mkdirSync(skills, { recursive: true })
    const real = join(skills, 'ae-transient-keep')
    const aside = join(skills, 'ae-transient-keep.__ae_removing_1_2')
    mkdirSync(real)
    mkdirSync(aside)
    writeFileSync(join(real, 'SKILL.md'), '---\nname: ae-transient-keep\ndescription: ok\n---\n', 'utf8')
    writeFileSync(join(aside, 'SKILL.md'), '---\nname: ae-transient-keep\ndescription: junk\n---\n', 'utf8')

    const found = discoverFilesystemSkills({
      cwd: home,
      projectRoot: home,
      env: { ...process.env, DSH_AGENTS_HOME: join(home, '.agents'), DSH_HOME: join(home, '.dsh') },
    })
    const names = found.map(entry => entry.name)
    expect(names).toContain('ae-transient-keep')
    expect(names.some(name => isTransientSkillEntryName(name))).toBe(false)
    expect(existsSync(aside)).toBe(false)
  })
})
