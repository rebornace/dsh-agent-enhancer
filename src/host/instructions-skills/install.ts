import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { purgeManagedSkillName } from './uninstall.ts'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AuxiliaryError } from '../../errors.ts'
import { isWindowsPathBusyError } from './fs-access.ts'
import { parseGitSkillSource, type ParsedGitSkillSource } from './git-source.ts'
import { fetchGithubRepoArchive } from './github-archive.ts'
import {
  findSkillBundles,
  installBundle,
  installTargetDir,
  resolveBundlesFromClone,
  type SkillBundle,
  type SkillInstallMode,
  type SkillInstallTarget,
} from './install-fs.ts'
import { contentRevisionOfDir } from './content-revision.ts'
import { upsertInstallRecord } from './install-ledger.ts'
import {
  setSkillInstallBytes,
  setSkillInstallStage,
} from './install-progress.ts'
import { agentsHomeOf, dshHomeOf, isKebabCaseName } from './paths.ts'

const execFileAsync = promisify(execFile)

export interface GitInstallBatchResult {
  readonly installed: readonly InstalledSkillRef[]
  readonly skippedBusy: readonly string[]
}

export interface InstalledSkillRef {
  readonly name: string
  readonly path: string
  readonly mode: 'link' | 'copy'
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

function execDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const withStderr = error as Error & {
    readonly stderr?: string | Buffer
    readonly stdout?: string | Buffer
  }
  const stderr = typeof withStderr.stderr === 'string'
    ? withStderr.stderr
    : Buffer.isBuffer(withStderr.stderr)
      ? withStderr.stderr.toString('utf8')
      : ''
  const interesting = stderr.trim() || error.message
  return interesting.slice(0, 600)
}

async function assertGitAvailable(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  try {
    await execFileAsync('git', ['--version'], { windowsHide: true, timeout: 15_000 })
  } catch {
    throw new AuxiliaryError('FILE_EDIT_FAILED', 'git is not available on PATH')
  }
}

function parseGitClonePercent(chunk: string): number | null {
  const match = /(?:Receiving objects|Resolving deltas):\s+(\d+)%/i.exec(chunk)
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null
}

async function shallowClone(
  cloneUrl: string,
  dest: string,
  signal: AbortSignal,
  onClonePercent?: (percent: number) => void,
): Promise<void> {
  signal.throwIfAborted()
  const attempts = 2
  let lastDetail = ''
  for (let i = 0; i < attempts; i += 1) {
    signal.throwIfAborted()
    try {
      await new Promise<void>((resolveClone, rejectClone) => {
        const child = spawn(
          'git',
          [
            '-c', 'http.version=HTTP/1.1',
            'clone', '--depth', '1', '--progress',
            '--', cloneUrl, dest,
          ],
          { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
        )
        let stderr = ''
        const onAbort = () => {
          try {
            child.kill()
          } catch {
            // best-effort
          }
        }
        signal.addEventListener('abort', onAbort, { once: true })
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk
          if (stderr.length > 8_000) stderr = stderr.slice(-4_000)
          const percent = parseGitClonePercent(chunk)
          if (percent !== null) onClonePercent?.(percent)
        })
        child.on('error', error => {
          signal.removeEventListener('abort', onAbort)
          rejectClone(error)
        })
        child.on('close', code => {
          signal.removeEventListener('abort', onAbort)
          if (signal.aborted) {
            rejectClone(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
            return
          }
          if (code === 0) {
            resolveClone()
            return
          }
          rejectClone(new Error(stderr.trim() || `git clone exited ${String(code)}`))
        })
      })
      signal.throwIfAborted()
      onClonePercent?.(100)
      return
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      lastDetail = execDetail(error)
      rmSync(dest, { recursive: true, force: true })
    }
  }
  throw new AuxiliaryError('FILE_EDIT_FAILED', `git clone failed: ${lastDetail}`)
}

export async function materializeSkillGitTreeFromSource(
  source: string,
  workDir: string,
  signal: AbortSignal,
  progressSessionId?: string,
): Promise<{ readonly rootDir: string, readonly parsed: ParsedGitSkillSource }> {
  const parsed = (() => {
    try {
      return parseGitSkillSource(source)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // Not FILE_DENIED — the client maps that to a generic「没有权限」string.
      throw new AuxiliaryError('FILE_EDIT_FAILED', detail)
    }
  })()
  const rootDir = await materializeRepo(parsed, workDir, signal, progressSessionId)
  return { rootDir, parsed }
}

async function materializeRepo(
  parsed: ParsedGitSkillSource,
  workDir: string,
  signal: AbortSignal,
  progressSessionId?: string,
): Promise<string> {
  const cloneDir = join(workDir, 'repo')
  const archiveErrors: string[] = []
  const sessionId = progressSessionId?.trim() ?? ''

  if (parsed.github !== null) {
    try {
      return await fetchGithubRepoArchive({
        owner: parsed.github.owner,
        repo: parsed.github.repo,
        workDir,
        signal,
        onStage: (stage, detail) => {
          if (sessionId === '') return
          setSkillInstallStage(sessionId, stage, detail ?? parsed.label)
        },
        onDownloadProgress: (received, total) => {
          if (sessionId === '') return
          setSkillInstallBytes(sessionId, received, total)
        },
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      archiveErrors.push(error instanceof Error ? error.message : String(error))
    }
  }

  await assertGitAvailable(signal)
  if (sessionId !== '') setSkillInstallStage(sessionId, 'cloning', parsed.label)
  try {
    await shallowClone(parsed.cloneUrl, cloneDir, signal, percent => {
      if (sessionId === '') return
      setSkillInstallBytes(sessionId, percent, 100)
    })
    return cloneDir
  } catch (cloneError) {
    const cloneDetail = cloneError instanceof Error ? cloneError.message : String(cloneError)
    const archiveNote = archiveErrors.length > 0
      ? ` Archive fallback also failed: ${archiveErrors.join(' | ')}`
      : ''
    throw new AuxiliaryError(
      'FILE_EDIT_FAILED',
      `${cloneDetail}.${archiveNote} Check network / proxy access to GitHub, then retry.`,
    )
  }
}

export async function installSkillsFromGit(options: {
  readonly source: string
  readonly target: SkillInstallTarget
  readonly projectRoot: string
  readonly force: boolean
  readonly env?: NodeJS.ProcessEnv
  readonly signal: AbortSignal
  readonly installLedgerRoot?: string
  /** When set, updates the in-memory install progress tracker for this session. */
  readonly progressSessionId?: string
}): Promise<GitInstallBatchResult> {
  const tempRoot = tempWorkDir('ae-skill-git-')
  const progressSessionId = options.progressSessionId?.trim() ?? ''
  try {
    const { rootDir: cloneDir, parsed: materialized } = await materializeSkillGitTreeFromSource(
      options.source,
      tempRoot,
      options.signal,
      progressSessionId === '' ? undefined : progressSessionId,
    )
    const bundles = resolveBundlesFromClone(cloneDir, materialized.subpath)
    if (bundles.length === 0) {
      throw new AuxiliaryError(
        'FILE_NOT_FOUND',
        `No skills found in ${materialized.label}. Expect SKILL.md under a kebab-case folder.`,
      )
    }
    const targetDir = installTargetDir(
      options.target,
      options.projectRoot,
      agentsHomeOf(options.env),
      dshHomeOf(options.env),
    )
    if (progressSessionId !== '') {
      setSkillInstallStage(progressSessionId, 'copying', materialized.label)
    }
    const installed: InstalledSkillRef[] = []
    const skippedBusy: string[] = []
    for (const bundle of bundles) {
      options.signal.throwIfAborted()
      try {
        if (progressSessionId !== '') {
          setSkillInstallStage(
            progressSessionId,
            'copying',
            `${bundle.name} · ${installed.length + skippedBusy.length + 1}/${bundles.length}`,
          )
        }
        // Atomic replace at target first. Never purge other roots beforehand —
        // a busy/skip after pre-purge left ~/.agents/skills/<name> missing and
        // skills-manager reported its source_ref (原路径) as lost.
        const result = installBundle({
          bundle,
          targetDir,
          force: options.force,
          mode: 'copy',
        })
        installed.push(result)
        if (options.force) {
          const folderName = basename(bundle.sourcePath)
          const names = new Set<string>([bundle.name])
          if (isKebabCaseName(folderName)) names.add(folderName)
          for (const name of names) {
            purgeManagedSkillName({
              name,
              cwd: options.projectRoot,
              projectRoot: options.projectRoot,
              env: options.env,
              exceptPaths: name === result.name ? [result.path] : [],
            })
          }
        }
        const ledgerRoot = options.installLedgerRoot?.trim()
        if (ledgerRoot !== undefined && ledgerRoot !== '') {
          upsertInstallRecord(ledgerRoot, {
            name: result.name,
            channel: 'github',
            source: options.source.trim(),
            contentRevision: contentRevisionOfDir(result.path),
            installedAt: new Date().toISOString(),
            updateCheck: true,
          })
        }
      } catch (error) {
        if (isWindowsPathBusyError(error) || (
          error instanceof AuxiliaryError
          && error.code === 'FILE_EDIT_FAILED'
          && isWindowsPathBusyError(error)
        )) {
          skippedBusy.push(bundle.name)
          continue
        }
        // Auxiliary busy hints use our own message text.
        if (
          error instanceof AuxiliaryError
          && error.code === 'FILE_EDIT_FAILED'
          && /still present|file in use|EPERM|EIO/i.test(error.message)
        ) {
          skippedBusy.push(bundle.name)
          continue
        }
        throw error
      }
    }
    if (installed.length === 0 && skippedBusy.length > 0) {
      throw new AuxiliaryError(
        'FILE_EDIT_FAILED',
        `Failed to update ${skippedBusy[0]}: still present (EPERM / EIO / file in use — close skill preview or Desktop file tabs, then retry)`,
      )
    }
    return { installed, skippedBusy }
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}

/** Resolve one skill bundle from an absolute skill dir, SKILL.md file, or flat .md. */
export function bundleFromSourcePath(sourcePath: string, nameHint?: string): SkillBundle {
  const absolute = resolve(sourcePath)
  if (!existsSync(absolute)) {
    throw new AuxiliaryError('FILE_NOT_FOUND', `Skill path not found: ${absolute}`)
  }

  const skillMdDirect = absolute.toLowerCase().endsWith('skill.md')
  if (skillMdDirect) {
    const dir = dirname(absolute)
    const name = basename(dir)
    if (!isKebabCaseName(name)) {
      throw new AuxiliaryError('FILE_DENIED', `Skill directory name must be kebab-case: ${name}`)
    }
    return { name, sourcePath: dir, kind: 'directory' }
  }

  if (existsSync(join(absolute, 'SKILL.md'))) {
    const name = nameHint?.trim() || basename(absolute)
    if (!isKebabCaseName(name)) {
      throw new AuxiliaryError('FILE_DENIED', `Skill directory name must be kebab-case: ${name}`)
    }
    return { name, sourcePath: absolute, kind: 'directory' }
  }

  if (absolute.toLowerCase().endsWith('.md')) {
    const name = nameHint?.trim() || basename(absolute).replace(/\.md$/i, '')
    if (!isKebabCaseName(name)) {
      throw new AuxiliaryError('FILE_DENIED', `Skill name must be kebab-case: ${name}`)
    }
    return { name, sourcePath: absolute, kind: 'file' }
  }

  const children = findSkillBundles(absolute)
  if (nameHint !== undefined && nameHint.trim() !== '') {
    const match = children.find(bundle => bundle.name === nameHint.trim())
    if (match !== undefined) return match
  }
  if (children.length === 1) return children[0]!
  throw new AuxiliaryError(
    'FILE_DENIED',
    children.length === 0
      ? `No skill bundle found at ${absolute}`
      : `Multiple skill bundles found at ${absolute}; pass an explicit name`,
  )
}

export function installSkillFromLocalPath(options: {
  readonly sourcePath: string
  readonly name?: string
  readonly target: SkillInstallTarget
  readonly projectRoot: string
  readonly force: boolean
  readonly mode: SkillInstallMode
  readonly env?: NodeJS.ProcessEnv
}): InstalledSkillRef {
  const bundle = bundleFromSourcePath(options.sourcePath, options.name)
  const targetDir = installTargetDir(
    options.target,
    options.projectRoot,
    agentsHomeOf(options.env),
    dshHomeOf(options.env),
  )
  return installBundle({
    bundle,
    targetDir,
    force: options.force,
    mode: options.mode,
  })
}

/** True when a local path should be treated as a skills zip archive. */
export function isSkillZipPath(path: string): boolean {
  return path.trim().toLowerCase().endsWith('.zip')
}
