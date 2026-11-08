/**
 * Fetch a GitHub repository as a zip archive (codeload / zipball).
 * Prefer this over `git clone` when HTTPS clone is reset or flaky.
 *
 * Resolves the default branch once, then downloads a single archive URL so the
 * UI does not restart "downloading" for every fallback candidate.
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

export type SkillArchiveDownloadProgress = (
  bytesReceived: number,
  bytesTotal: number | null,
) => void

async function downloadUrl(
  url: string,
  destFile: string,
  signal: AbortSignal,
  onBytes?: SkillArchiveDownloadProgress,
): Promise<void> {
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
  const lengthHeader = response.headers.get('content-length')
  const parsedTotal = lengthHeader !== null ? Number(lengthHeader) : Number.NaN
  const bytesTotal = Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : null
  let bytesReceived = 0
  onBytes?.(0, bytesTotal)

  const source = Readable.fromWeb(response.body as NodeReadableStream)
  source.on('data', (chunk: Buffer | string) => {
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    bytesReceived += size
    onBytes?.(bytesReceived, bytesTotal)
  })
  await pipeline(source, createWriteStream(destFile))
  signal.throwIfAborted()
  onBytes?.(bytesReceived, bytesTotal)
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

async function resolveDefaultBranch(
  owner: string,
  repo: string,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted()
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-agent-enhancer-skill-install',
      },
    })
    if (!response.ok) return null
    const body = await response.json() as { readonly default_branch?: unknown }
    return typeof body.default_branch === 'string' && body.default_branch.trim() !== ''
      ? body.default_branch.trim()
      : null
  } catch {
    return null
  }
}

function archiveCandidates(owner: string, repo: string, defaultBranch: string | null): string[] {
  const urls: string[] = []
  if (defaultBranch !== null) {
    urls.push(`https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${encodeURIComponent(defaultBranch)}`)
  }
  urls.push(
    `https://api.github.com/repos/${owner}/${repo}/zipball`,
    `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/main`,
    `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/master`,
  )
  return [...new Set(urls)]
}

/**
 * Download the default-branch zipball for owner/repo into `workDir/repo`.
 * Emits `downloading` once; retries keep the same stage (detail may change).
 */
export async function fetchGithubRepoArchive(options: {
  readonly owner: string
  readonly repo: string
  readonly workDir: string
  readonly signal: AbortSignal
  readonly onDownloadProgress?: SkillArchiveDownloadProgress
  readonly onStage?: (stage: 'downloading' | 'extracting', detail?: string) => void
}): Promise<string> {
  const { owner, repo, workDir, signal, onDownloadProgress, onStage } = options
  mkdirSync(workDir, { recursive: true })
  const zipPath = join(workDir, 'repo.zip')
  const extractDir = join(workDir, 'extract')
  mkdirSync(extractDir, { recursive: true })

  const defaultBranch = await resolveDefaultBranch(owner, repo, signal)
  const candidates = archiveCandidates(owner, repo, defaultBranch)
  const errors: string[] = []
  let downloadStarted = false

  for (let index = 0; index < candidates.length; index += 1) {
    const url = candidates[index]!
    signal.throwIfAborted()
    try {
      rmSync(zipPath, { force: true })
      rmSync(extractDir, { recursive: true, force: true })
      mkdirSync(extractDir, { recursive: true })
      const detail = index === 0
        ? `${owner}/${repo}`
        : `${owner}/${repo} · retry ${index + 1}/${candidates.length}`
      if (!downloadStarted) {
        onStage?.('downloading', detail)
        downloadStarted = true
      } else {
        onStage?.('downloading', detail)
      }
      await downloadUrl(url, zipPath, signal, onDownloadProgress)
      onStage?.('extracting', `${owner}/${repo}`)
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
