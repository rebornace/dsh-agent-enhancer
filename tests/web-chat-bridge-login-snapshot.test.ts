import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WEB_CHAT_OFFICIAL_ORIGIN } from '../src/host/web-chat-bridge/login-snapshot-types.ts'
import {
  clearWebChatLoginSnapshot,
  loadWebChatLoginSnapshot,
  saveWebChatLoginSnapshot,
  sanitizeLocalStorage,
  webChatLoginSnapshotPath,
} from '../src/host/web-chat-bridge/login-snapshot.ts'

const dirs: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'web-chat-snapshot-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('web chat login snapshot store', () => {
  it('rejects password-like localStorage keys and wrong origin on disk', () => {
    const root = tempRoot()
    const saved = saveWebChatLoginSnapshot(root, {
      localStorage: {
        token: 'abc',
        userPassword: 'must-not-persist',
      },
      cookie: 'session=1',
      savedAt: '2026-11-09T00:00:00.000Z',
    })
    expect(saved).not.toBeNull()
    expect(saved!.localStorage).toEqual({ token: 'abc' })
    expect(webChatLoginSnapshotPath(root)).toContain('session.json')
    const onDisk = JSON.parse(readFileSync(webChatLoginSnapshotPath(root), 'utf8')) as {
      origin: string
      localStorage: Record<string, string>
    }
    expect(onDisk.origin).toBe(WEB_CHAT_OFFICIAL_ORIGIN)
    expect(onDisk.localStorage).toEqual({ token: 'abc' })
  })

  it('load and clear round-trip', () => {
    const root = tempRoot()
    expect(loadWebChatLoginSnapshot(root)).toBeNull()
    saveWebChatLoginSnapshot(root, {
      localStorage: { a: '1' },
      cookie: '',
      savedAt: '2026-11-09T00:00:00.000Z',
    })
    expect(loadWebChatLoginSnapshot(root)?.localStorage).toEqual({ a: '1' })
    expect(clearWebChatLoginSnapshot(root)).toBe(true)
    expect(loadWebChatLoginSnapshot(root)).toBeNull()
    expect(clearWebChatLoginSnapshot(root)).toBe(false)
  })

  it('sanitizeLocalStorage drops sensitive keys', () => {
    expect(sanitizeLocalStorage({
      ok: '1',
      client_passwd_hint: 'x',
    })).toEqual({ ok: '1' })
  })

  it('does not overwrite disk snapshot when capture is weaker', () => {
    const root = tempRoot()
    saveWebChatLoginSnapshot(root, {
      localStorage: { token: 'keep' },
      cookie: '',
      savedAt: '2026-11-09T00:00:00.000Z',
    })
    saveWebChatLoginSnapshot(root, {
      localStorage: {},
      cookie: '',
      savedAt: '2026-11-09T01:00:00.000Z',
    })
    expect(loadWebChatLoginSnapshot(root)?.localStorage).toEqual({ token: 'keep' })
    const onDisk = JSON.parse(readFileSync(webChatLoginSnapshotPath(root), 'utf8')) as {
      savedAt: string
    }
    expect(onDisk.savedAt).toBe('2026-11-09T00:00:00.000Z')
  })
})
