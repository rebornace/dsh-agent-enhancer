import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cwdStorageKey } from './paths.ts'
import {
  EXTRA_FOLDERS_VERSION,
  type ExtraFolderRoot,
  type ExtraFoldersDocument,
} from './types.ts'

export interface ExtraFoldersStore {
  readonly rootDir: string
  load(primaryCwd: string): ExtraFoldersDocument
  save(primaryCwd: string, roots: readonly ExtraFolderRoot[]): ExtraFoldersDocument
}

function emptyDoc(primaryCwd: string): ExtraFoldersDocument {
  return {
    version: EXTRA_FOLDERS_VERSION,
    primaryCwd,
    roots: [],
  }
}

function parseDoc(raw: string, primaryCwd: string): ExtraFoldersDocument {
  try {
    const parsed = JSON.parse(raw) as Partial<ExtraFoldersDocument>
    if (parsed.version !== EXTRA_FOLDERS_VERSION || !Array.isArray(parsed.roots)) {
      return emptyDoc(primaryCwd)
    }
    const roots: ExtraFolderRoot[] = []
    for (const entry of parsed.roots) {
      if (
        entry === null
        || typeof entry !== 'object'
        || typeof entry.path !== 'string'
        || entry.path.trim() === ''
      ) {
        continue
      }
      const title = typeof entry.title === 'string' && entry.title.trim() !== ''
        ? entry.title.trim()
        : entry.path
      roots.push({ path: entry.path, title })
    }
    return {
      version: EXTRA_FOLDERS_VERSION,
      primaryCwd,
      roots,
    }
  } catch {
    return emptyDoc(primaryCwd)
  }
}

export function createExtraFoldersStore(rootDir: string): ExtraFoldersStore {
  mkdirSync(rootDir, { recursive: true })

  const fileOf = (primaryCwd: string) => join(rootDir, `${cwdStorageKey(primaryCwd)}.json`)

  return {
    rootDir,
    load(primaryCwd: string): ExtraFoldersDocument {
      const file = fileOf(primaryCwd)
      try {
        return parseDoc(readFileSync(file, 'utf8'), primaryCwd)
      } catch (error) {
        const code = error !== null && typeof error === 'object'
          ? String(Reflect.get(error, 'code') ?? '')
          : ''
        if (code === 'ENOENT') return emptyDoc(primaryCwd)
        return emptyDoc(primaryCwd)
      }
    },
    save(primaryCwd: string, roots: readonly ExtraFolderRoot[]): ExtraFoldersDocument {
      const doc: ExtraFoldersDocument = {
        version: EXTRA_FOLDERS_VERSION,
        primaryCwd,
        roots: [...roots],
      }
      const file = fileOf(primaryCwd)
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
      return doc
    },
  }
}
