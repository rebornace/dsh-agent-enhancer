import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureResolvableWorkspaceCwd,
  WebChatImportError,
} from './import-session.ts'

const scratch: string[] = []

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('ensureResolvableWorkspaceCwd', () => {
  it('recreates a missing workspace folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-webchat-cwd-'))
    scratch.push(root)
    const missing = join(root, 'gone', 'project')
    const ensured = ensureResolvableWorkspaceCwd(missing)
    expect(ensured).toBe(missing)
    expect(ensureResolvableWorkspaceCwd(missing)).toBe(missing)
  })

  it('rejects a path that is a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-webchat-cwd-'))
    scratch.push(root)
    const file = join(root, 'not-a-dir')
    writeFileSync(file, 'x')
    expect(() => ensureResolvableWorkspaceCwd(file)).toThrow(WebChatImportError)
    try {
      ensureResolvableWorkspaceCwd(file)
    } catch (error) {
      expect(error).toMatchObject({ code: 'missing-cwd' })
    }
  })
})
