import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AuxiliaryError } from '../../errors.ts'
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
import { agentsHomeOf, isKebabCaseName } from './paths.ts'

const execFileAsync = promisify(execFile)

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

async function shallowClone(
  cloneUrl: string,
  dest: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const attempts = 2
  let lastDetail = ''
  for (let i = 0; i < attempts; i += 1) {
    signal.throwIfAborted()
    try {
      await execFileAsync(
        'git',
        ['-c', 'http.version=HTTP/1.1', 'clone', '--depth', '1', '--', cloneUrl, dest],
        { windowsHide: true, timeout: 180_000 },
      )
      signal.throwIfAborted()
      return
    } catch (error) {
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
): Promise<{ readonly rootDir: string, readonly parsed: ParsedGitSkillSource }> {
  const parsed = (() => {
    try {
      return parseGitSkillSource(source)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new AuxiliaryError('FILE_DENIED', detail)
    }
  })()
  const rootDir = await materializeRepo(parsed, workDir, signal)
  return { rootDir, parsed }
}

async function materializeRepo(
  parsed: ParsedGitSkillSource,
  workDir: string,
  signal: AbortSignal,
): Promise<string> {
  const cloneDir = join(workDir, 'repo')
  const archiveErrors: string[] = []

  if (parsed.github !== null) {
    try {
      return await fetchGithubRepoArchive({
        owner: parsed.github.owner,
        repo: parsed.github.repo,
        workDir,
        signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      archiveErrors.push(error instanceof Error ? error.message : String(error))
    }
  }

  await assertGitAvailable(signal)
  try {
    await shallowClone(parsed.cloneUrl, cloneDir, signal)
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
}): Promise<readonly InstalledSkillRef[]> {
  const tempRoot = tempWorkDir('ae-skill-git-')
  try {
    const { rootDir: cloneDir, parsed: materialized } = await materializeSkillGitTreeFromSource(
      options.source,
      tempRoot,
      options.signal,
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
    )
    const installed: InstalledSkillRef[] = []
    for (const bundle of bundles) {
      options.signal.throwIfAborted()
      const result = installBundle({
        bundle,
        targetDir,
        force: options.force,
        mode: 'copy',
      })
      installed.push(result)
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
    }
    return installed
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
