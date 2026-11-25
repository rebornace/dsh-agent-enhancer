import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCursorStore } from '../src/host/remote/weixin/cursor.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cursor-'))
  dirs.push(dir)
  return join(dir, 'cursor.json')
}

describe('createCursorStore', () => {
  it('keeps the cursor across instances', () => {
    const file = tempFile()
    const first = createCursorStore({ filePath: file })
    expect(first.get()).toBe('')
    first.set('cursor-1')
    expect(first.get()).toBe('cursor-1')

    const second = createCursorStore({ filePath: file })
    expect(second.get()).toBe('cursor-1')
    expect(readFileSync(file, 'utf8')).toContain('cursor-1')
  })

  it('falls back on a corrupt file instead of throwing', () => {
    const file = tempFile()
    writeFileSync(file, 'not json')
    expect(createCursorStore({ filePath: file }).get()).toBe('')
  })

  it('stays in memory when no file is configured', () => {
    const store = createCursorStore({ filePath: null, initial: 'start' })
    expect(store.get()).toBe('start')
    store.set('next')
    expect(store.get()).toBe('next')
  })
})
