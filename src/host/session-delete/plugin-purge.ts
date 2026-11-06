import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CheckpointStore } from '../checkpoint/store.ts'
import type { SessionCutStore } from '../checkpoint/cut-store.ts'
import type { SessionCleaner } from './cleanup.ts'

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function shortDigest(value: string, length = 16): string {
  return digest(value).slice(0, length)
}

async function removeIfPresent(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  await rm(path, { recursive: true, force: true })
  return true
}

async function unlinkIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path)
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

/**
 * Purge checkpoint / cut / shadow / journal rows for one session.
 * Shadow dirs (legacy) are named by the first 16 hex of sha256(sessionId).
 */
export function createCheckpointCleaner(options: {
  readonly store: CheckpointStore
  readonly cutStore: SessionCutStore
  readonly storageRoot: string
}): SessionCleaner {
  return {
    id: 'checkpoint',
    label: 'Checkpoint / cut / shadow data',
    async purge(sessionId, signal) {
      signal.throwIfAborted()
      await options.store.replace(sessionId, [])
      signal.throwIfAborted()
      await options.cutStore.set(sessionId, null)

      const key = shortDigest(sessionId)
      await removeIfPresent(join(options.storageRoot, 'shadow', key))
      await removeIfPresent(join(options.storageRoot, 'shadow-git', key))

      // Drop journals that still name this session (id is journal UUID, not session).
      const journalDir = join(options.storageRoot, 'journals')
      try {
        const names = await readdir(journalDir)
        for (const name of names) {
          signal.throwIfAborted()
          if (!name.endsWith('.json')) continue
          const path = join(journalDir, name)
          try {
            const raw = JSON.parse(await readFile(path, 'utf8')) as { sessionId?: unknown }
            if (raw.sessionId === sessionId) await unlinkIfPresent(path)
          } catch {
            // Ignore unreadable / non-journal files.
          }
        }
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
          throw error
        }
      }
    },
  }
}

/** Purge per-session context-exclude files under plugin-data. */
export function createContextExcludeCleaner(pluginDataRoot: string): SessionCleaner {
  return {
    id: 'context-exclude',
    label: 'Context exclude rules',
    async purge(sessionId, signal) {
      signal.throwIfAborted()
      const dir = join(pluginDataRoot, 'context-exclude', 'sessions')
      const hashed = join(dir, `${digest(sessionId)}.json`)
      const raw = join(dir, `${sessionId}.json`)
      await unlinkIfPresent(hashed)
      await unlinkIfPresent(raw)
    },
  }
}
