/**
 * Install skills from a local .zip archive (generic path for skill packs).
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { isKebabCaseName } from './paths.ts'
import { promisify } from 'node:util'
import { AuxiliaryError } from '../../errors.ts'
import { unwrapArchiveRoot } from './github-archive.ts'
import {
  installBundle,
  installTargetDir,
  resolveBundlesFromClone,
  type SkillInstallTarget,
} from './install-fs.ts'
import { upsertInstallRecord } from './install-ledger.ts'
import { agentsHomeOf } from './paths.ts'
import type { InstalledSkillRef } from './install.ts'
import { purgeManagedSkillName } from './uninstall.ts'

const execFileAsync = promisify(execFile)

function tempWorkDir(prefix: string): string {
  let base = tmpdir()
  try {
    base = realpathSync(base)
  } catch {
    // keep short path
  }
  return mkdtempSync(join(base, prefix))
}

async function extractZipArchive(
  zipPath: string,
  destDir: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  mkdirSync(destDir, { recursive: true })
  try {
    await execFileAsync('tar', ['-xf', zipPath, '-C', destDir], {
      windowsHide: true,
      timeout: 120_000,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AuxiliaryError('FILE_EDIT_FAILED', `unzip failed: ${detail}`)
  }
  signal.throwIfAborted()
}

export async function installSkillsFromZipFile(options: {
  readonly zipPath: string
  readonly target: SkillInstallTarget
  readonly projectRoot: string
  readonly force: boolean
  readonly env?: NodeJS.ProcessEnv
  readonly signal: AbortSignal
  readonly installLedgerRoot?: string
}): Promise<readonly InstalledSkillRef[]> {
  const zipPath = resolve(options.zipPath)
  if (!existsSync(zipPath)) {
    throw new AuxiliaryError('FILE_NOT_FOUND', `Zip not found: ${zipPath}`)
  }
  if (!zipPath.toLowerCase().endsWith('.zip')) {
    throw new AuxiliaryError('FILE_DENIED', `Expected a .zip archive: ${basename(zipPath)}`)
  }

  const workDir = tempWorkDir('ae-skill-zip-')
  const extractDir = join(workDir, 'extract')
  try {
    await extractZipArchive(zipPath, extractDir, options.signal)
    const root = unwrapArchiveRoot(extractDir)
    const bundles = resolveBundlesFromClone(root, null)
    if (bundles.length === 0) {
      throw new AuxiliaryError(
        'FILE_NOT_FOUND',
        'No skills found in the zip. Expect SKILL.md under a kebab-case folder.',
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
          })
        }
      }
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
          channel: 'zip',
          source: null,
          contentRevision: null,
          installedAt: new Date().toISOString(),
          updateCheck: false,
        })
      }
    }
    return installed
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
}
