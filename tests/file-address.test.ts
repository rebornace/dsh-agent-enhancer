import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  absoluteFileAddress,
  fileAddressFor,
  isAbsoluteWorkspacePath,
  skillDocumentPath,
} from '../src/client/file-edit/address.ts'

const SESSION = 'sess-1' as SessionId

describe('skill document address helpers', () => {
  it('detects absolute Windows and POSIX paths', () => {
    expect(isAbsoluteWorkspacePath('C:/Users/a/SKILL.md')).toBe(true)
    expect(isAbsoluteWorkspacePath('/home/a/SKILL.md')).toBe(true)
    expect(isAbsoluteWorkspacePath('relative/SKILL.md')).toBe(false)
  })

  it('appends SKILL.md for skill directories', () => {
    expect(skillDocumentPath('C:/Users/a/.agents/skills/demo')).toBe(
      'C:/Users/a/.agents/skills/demo/SKILL.md',
    )
    expect(skillDocumentPath('C:/Users/a/.agents/skills/demo/SKILL.md')).toBe(
      'C:/Users/a/.agents/skills/demo/SKILL.md',
    )
  })

  it('keeps outside-workspace absolute paths on the session scope (FilesBody peer)', () => {
    const address = fileAddressFor(
      SESSION,
      'C:/work/project',
      'C:/Users/me/.agents/skills/demo/SKILL.md',
    )
    expect(address.startsWith('dsh-resource://file/session/')).toBe(true)
    expect(address).toContain('C:')
    expect(address).toContain('demo/SKILL.md')
  })

  it('relativizes in-workspace paths on the session scope', () => {
    const address = fileAddressFor(
      SESSION,
      'C:/work/project',
      'C:/work/project/.agents/skills/demo/SKILL.md',
    )
    expect(address.startsWith('dsh-resource://file/session/')).toBe(true)
    expect(address).toContain('.agents/skills/demo/SKILL.md')
  })

  it('still exposes absoluteFileAddress helper', () => {
    expect(absoluteFileAddress('C:/Users/me/.agents/skills/demo/SKILL.md'))
      .toContain('dsh-resource://file/absolute/')
  })
})
