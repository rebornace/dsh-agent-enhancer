import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isExcludedSegment, readSnapshot, snapshotHash, unsafePath } from './files.ts'
import type { CurrentSnapshot } from './files.ts'
import type { FileCheckpoint } from './types.ts'

/** Soft limit on files visited while scanning a workspace tree. */
export const MAX_WORKSPACE_SCAN_FILES = 2000
/** Soft limit on path diffs recorded from one shell tool invocation. */
export const MAX_SHELL_CHANGED_FILES = 200

export type WorkspaceSnapshotMap = Map<string, CurrentSnapshot>

export interface WorkspaceScanResult {
  readonly files: WorkspaceSnapshotMap
  /** True when the walk stopped early due to caps or I/O failure. */
  readonly truncated: boolean
}

/**
 * Recursively snapshot UTF-8 text files under `workspaceRoot`, skipping the same
 * excluded segments / unsafe paths used by checkpoint restore.
 */
export async function scanWorkspace(
  workspaceRoot: string,
  options: { readonly maxFiles?: number } = {},
): Promise<WorkspaceScanResult> {
  const maxFiles = options.maxFiles ?? MAX_WORKSPACE_SCAN_FILES
  const files: WorkspaceSnapshotMap = new Map()
  let truncated = false

  const visit = async (absoluteDir: string, relativeDir: string): Promise<void> => {
    if (truncated) return
    let entries
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true })
    } catch {
      truncated = true
      return
    }
    for (const entry of entries) {
      if (truncated) return
      if (isExcludedSegment(entry.name)) continue
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      const absolutePath = join(absoluteDir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath.split('\\').join('/'))
        continue
      }
      if (!entry.isFile()) continue
      const path = relativePath.split('\\').join('/')
      if (unsafePath(path)) continue
      if (files.size >= maxFiles) {
        truncated = true
        return
      }
      try {
        const snapshot = await readSnapshot(workspaceRoot, path)
        if (snapshot.exists) files.set(path, snapshot)
      } catch {
        // Symlink / binary / too-large / not-regular: skip without failing the scan.
      }
    }
  }

  await visit(workspaceRoot, '')
  return { files, truncated }
}

/**
 * Diff two workspace scans into FileCheckpoint rows. Caps how many changes are
 * emitted; callers treat `truncated` as a soft workspace gap.
 */
export function diffSnapshots(
  before: WorkspaceSnapshotMap,
  after: WorkspaceSnapshotMap,
  options: { readonly maxChanges?: number } = {},
): { readonly files: readonly FileCheckpoint[], readonly truncated: boolean } {
  const maxChanges = options.maxChanges ?? MAX_SHELL_CHANGED_FILES
  const files: FileCheckpoint[] = []
  let truncated = false

  const push = (checkpoint: FileCheckpoint): void => {
    if (files.length >= maxChanges) {
      truncated = true
      return
    }
    files.push(checkpoint)
  }

  for (const [path, afterSnap] of after) {
    if (truncated) break
    const beforeSnap = before.get(path) ?? { path, exists: false, text: null }
    const beforeHash = snapshotHash(beforeSnap)
    const afterHash = snapshotHash(afterSnap)
    if (beforeHash === afterHash) continue
    push({
      path,
      change: !beforeSnap.exists ? 'create' : 'modify',
      beforeText: beforeSnap.exists ? beforeSnap.text : null,
      beforeHash,
      afterText: afterSnap.exists ? afterSnap.text : null,
      afterHash,
    })
  }

  for (const [path, beforeSnap] of before) {
    if (truncated) break
    if (after.has(path)) continue
    const afterSnap: CurrentSnapshot = { path, exists: false, text: null }
    const beforeHash = snapshotHash(beforeSnap)
    const afterHash = snapshotHash(afterSnap)
    if (beforeHash === afterHash) continue
    push({
      path,
      change: 'delete',
      beforeText: beforeSnap.exists ? beforeSnap.text : null,
      beforeHash,
      afterText: null,
      afterHash,
    })
  }

  return { files, truncated }
}
