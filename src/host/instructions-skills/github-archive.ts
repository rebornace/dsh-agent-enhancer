/**
 * Fetch a GitHub repository as a zip archive (codeload / zipball).
 * Prefer this over `git clone` when HTTPS clone is reset or flaky.
 */
import { execFile } from 'node:child_process'
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { AuxiliaryError } from '../../errors.ts'

const execFileAsync = promisify(execFile)

function detailOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const withStderr = error as Error & { readonly stderr?: string | Buffer }
  const stderr = typeof withStderr.stderr === 'string'
    ? withStderr.stderr
    : Buffer.isBuffer(withStderr.stderr)
      ? withStderr.stderr.toString('utf8')
      : ''
  const body = [error.message, stderr.trim()].filter(part => part !== '').join('\n')
  return body.slice(0, 800)
}

async function downloadUrl(url: string, destFile: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const response = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: {
      Accept: 'application/zip',
      'User-Agent': 'dsh-agent-enhancer-skill-install',
    },
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`)
  }
  if (response.body === null) {
    throw new Error(`Empty body from ${url}`)
  }
  await pipeline(
    Readable.fromWeb(response.body as NodeReadableStream),
    createWriteStream(destFile),
  )
  signal.throwIfAborted()
}

async function extractZip(zipPath: string, destDir: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  mkdirSync(destDir, { recursive: true })
  try {
    await execFileAsync('tar', ['-xf', zipPath, '-C', destDir], {
      windowsHide: true,
      timeout: 120_000,
    })
  } catch (error) {
    throw new AuxiliaryError('FILE_EDIT_FAILED', `unzip failed: ${detailOf(error)}`)
  }
  signal.throwIfAborted()
}

/** GitHub zipballs unpack into a single top-level folder. */
export function unwrapArchiveRoot(extractDir: string): string {
  let entries: string[]
  try {
    entries = readdirSync(extractDir).filter(name => name !== '__MACOSX')
  } catch {
    return extractDir
  }
  if (entries.length !== 1) return extractDir
  const only = join(extractDir, entries[0]!)
  try {
    if (statSync(only).isDirectory()) return only
  } catch {
    return extractDir
  }
  return only
}

/**
 * Download the default-branch zipball for owner/repo into `workDir/repo`.
 * Tries API zipball first (follows default branch), then codeload main/master.
 */
export async function fetchGithubRepoArchive(options: {
  readonly owner: string
  readonly repo: string
  readonly workDir: string
  readonly signal: AbortSignal
}): Promise<string> {
  const { owner, repo, workDir, signal } = options
  mkdirSync(workDir, { recursive: true })
  const zipPath = join(workDir, 'repo.zip')
  const extractDir = join(workDir, 'extract')
  mkdirSync(extractDir, { recursive: true })

  const candidates = [
    `https://api.github.com/repos/${owner}/${repo}/zipball`,
    `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/main`,
    `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/master`,
  ]

  const errors: string[] = []
  for (const url of candidates) {
    signal.throwIfAborted()
    try {
      rmSync(zipPath, { force: true })
      rmSync(extractDir, { recursive: true, force: true })
      mkdirSync(extractDir, { recursive: true })
      await downloadUrl(url, zipPath, signal)
      await extractZip(zipPath, extractDir, signal)
      const root = unwrapArchiveRoot(extractDir)
      const repoDir = join(workDir, 'repo')
      rmSync(repoDir, { recursive: true, force: true })
      renameSync(root, repoDir)
      try {
        rmSync(zipPath, { force: true })
        rmSync(extractDir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
      return repoDir
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      errors.push(`${url}: ${detailOf(error)}`)
    }
  }

  const allNotFound = errors.length > 0 && errors.every(entry => /HTTP\s*404/i.test(entry))
  if (allNotFound) {
    throw new AuxiliaryError(
      'FILE_NOT_FOUND',
      `GitHub repository not found: ${owner}/${repo}`,
    )
  }
  throw new AuxiliaryError(
    'FILE_EDIT_FAILED',
    `GitHub archive download failed for ${owner}/${repo}. ${errors.join(' | ')}`,
  )
}
