import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { AuxiliaryError } from '../../errors.ts'
import { isKebabCaseName } from './paths.ts'

const AGENTS_STUB = `# Agent notes

Standing guidance for agents working in this workspace.

## Scope

- Prefer repository conventions and existing docs over inventing parallel process.
- Keep changes small and verifiable.
`

function titleCaseFromKebab(name: string): string {
  return name
    .split('-')
    .filter(part => part.length > 0)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function skillStubMarkdown(name: string): string {
  const title = titleCaseFromKebab(name)
  return `---
name: ${name}
description: Brief description of when to use this skill.
---

# ${title}

Instructions for the agent go here.
`
}

export function createWorkspaceAgentsFile(projectRoot: string): { readonly path: string, readonly created: boolean } {
  const path = resolve(projectRoot, 'AGENTS.md')
  if (existsSync(path)) {
    throw new AuxiliaryError('FILE_DENIED', 'AGENTS.md already exists at the workspace root')
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, AGENTS_STUB, 'utf8')
  return { path, created: true }
}

export function createWorkspaceSkill(
  projectRoot: string,
  rawName: string,
): { readonly path: string, readonly created: boolean, readonly name: string } {
  const name = rawName.trim()
  if (!isKebabCaseName(name)) {
    throw new AuxiliaryError('FILE_DENIED', 'Skill name must be kebab-case')
  }
  const dir = join(resolve(projectRoot), '.agents', 'skills', name)
  const path = join(dir, 'SKILL.md')
  if (existsSync(path) || existsSync(dir)) {
    throw new AuxiliaryError('FILE_DENIED', 'A skill with that name already exists')
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, skillStubMarkdown(name), 'utf8')
  return { path, created: true, name }
}
