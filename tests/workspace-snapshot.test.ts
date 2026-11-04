import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  MAX_SHELL_CHANGED_FILES,
  diffSnapshots,
  scanWorkspace,
} from '../src/host/checkpoint/workspace-snapshot.ts'
import type { CurrentSnapshot } from '../src/host/checkpoint/files.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-snap-'))
  temporaryDirectories.push(root)
  return root
}

it('scans text files and skips excluded segments', async () => {
  const root = await workspace()
  await writeFile(join(root, 'a.txt'), 'alpha', 'utf8')
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'secret', 'utf8')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'b.txt'), 'beta', 'utf8')

  const scan = await scanWorkspace(root)
  expect(scan.truncated).toBe(false)
  expect([...scan.files.keys()].sort()).toEqual(['a.txt', 'src/b.txt'])
  expect(scan.files.get('a.txt')).toMatchObject({ exists: true, text: 'alpha' })
})

it('diffs creates modifies and deletes', () => {
  const before = new Map<string, CurrentSnapshot>([
    ['keep.txt', { path: 'keep.txt', exists: true, text: 'same' }],
    ['gone.txt', { path: 'gone.txt', exists: true, text: 'bye' }],
    ['edit.txt', { path: 'edit.txt', exists: true, text: 'old' }],
  ])
  const after = new Map<string, CurrentSnapshot>([
    ['keep.txt', { path: 'keep.txt', exists: true, text: 'same' }],
    ['edit.txt', { path: 'edit.txt', exists: true, text: 'new' }],
    ['new.txt', { path: 'new.txt', exists: true, text: '' }],
  ])
  const { files, truncated } = diffSnapshots(before, after)
  expect(truncated).toBe(false)
  expect(files).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'new.txt', change: 'create', beforeText: null, afterText: '' }),
    expect.objectContaining({ path: 'edit.txt', change: 'modify', beforeText: 'old', afterText: 'new' }),
    expect.objectContaining({ path: 'gone.txt', change: 'delete', beforeText: 'bye', afterText: null }),
  ]))
  expect(files).toHaveLength(3)
  const created = files.find(file => file.path === 'new.txt')!
  expect(created.beforeHash).toBe('')
  expect(created.afterHash).toBe(createHash('sha256').update('').digest('hex'))
})

it('marks diff truncated when change cap is hit', () => {
  const before = new Map<string, CurrentSnapshot>()
  const after = new Map<string, CurrentSnapshot>()
  for (let index = 0; index < MAX_SHELL_CHANGED_FILES + 5; index += 1) {
    const path = `f${index}.txt`
    after.set(path, { path, exists: true, text: String(index) })
  }
  const { files, truncated } = diffSnapshots(before, after)
  expect(truncated).toBe(true)
  expect(files).toHaveLength(MAX_SHELL_CHANGED_FILES)
})

it('marks scan truncated when file cap is hit', async () => {
  const root = await workspace()
  for (let index = 0; index < 12; index += 1) {
    await writeFile(join(root, `f${index}.txt`), 'x', 'utf8')
  }
  const scan = await scanWorkspace(root, { maxFiles: 10 })
  expect(scan.truncated).toBe(true)
  expect(scan.files.size).toBe(10)
})
