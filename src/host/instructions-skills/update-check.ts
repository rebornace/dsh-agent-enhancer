import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentRevisionOfDir } from './content-revision.ts'
import { parseGitSkillSource } from './git-source.ts'
import type { SkillInstallRecord } from './install-ledger.ts'
import { materializeSkillGitTreeFromSource } from './install.ts'
import { resolveBundlesFromClone } from './install-fs.ts'

export interface GithubSkillUpdateCheck {
  readonly updateAvailable: boolean
  readonly updateSourceLabel: string | null
  readonly updateCheckFailed: boolean
}

function tempWorkDir(prefix: string): string {
  let base = tmpdir()
  try {
    base = realpathSync(base)
  } catch {
    // keep short path if realpath fails
  }
  return mkdtempSync(join(base, prefix))
}

function revisionPathForBundle(
  bundle: { readonly name: string, readonly sourcePath: string, readonly kind: 'directory' | 'file' },
): string {
  return bundle.kind === 'directory' ? bundle.sourcePath : bundle.sourcePath
}

function sourceLabel(source: string): string | null {
  const trimmed = source.trim()
  if (trimmed === '') return null
  try {
    return parseGitSkillSource(trimmed).label
  } catch {
    return trimmed
  }
}

const checkResult = (
  updateAvailable: boolean,
  label: string | null,
  updateCheckFailed: boolean,
): GithubSkillUpdateCheck => ({
  updateAvailable,
  updateSourceLabel: label,
  updateCheckFailed,
})

const noUpdate = (label: string | null = null, failed = false): GithubSkillUpdateCheck =>
  checkResult(false, label, failed)

/**
 * Compare remote GitHub skill tree revision with the install ledger fingerprint.
 * Never throws — failures yield `updateAvailable: false`.
 */
export async function checkGithubSkillUpdate(
  record: SkillInstallRecord,
  options?: {
    readonly signal?: AbortSignal
    /** Reserved for archive download overrides in tests. */
    readonly fetch?: typeof fetch
  },
): Promise<GithubSkillUpdateCheck> {
  void options?.fetch
  if (record.channel !== 'github' || record.updateCheck !== true) {
    return noUpdate()
  }
  const source = record.source?.trim() ?? ''
  if (source === '') return noUpdate()
  const stored = record.contentRevision?.trim() ?? ''
  if (stored === '') return noUpdate(sourceLabel(source))

  const signal = options?.signal ?? new AbortController().signal
  const label = sourceLabel(source)
  const tempRoot = tempWorkDir('ae-skill-update-')
  try {
    signal.throwIfAborted()
    const { rootDir, parsed } = await materializeSkillGitTreeFromSource(source, tempRoot, signal)
    const bundles = resolveBundlesFromClone(rootDir, parsed.subpath)
    const bundle = bundles.find(entry => entry.name === record.name)
    if (bundle === undefined) return noUpdate(label, true)
    const revisionRoot = revisionPathForBundle(bundle)
    let remoteRevision: string
    try {
      remoteRevision = contentRevisionOfDir(revisionRoot)
    } catch {
      return noUpdate(label, true)
    }
    return checkResult(remoteRevision !== stored, label, false)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    return noUpdate(label, true)
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}

/** Zip / no updateCheck / missing source never report updates. */
export async function resolveUpdateFlag(record: SkillInstallRecord): Promise<boolean> {
  return (await checkGithubSkillUpdate(record)).updateAvailable
}
