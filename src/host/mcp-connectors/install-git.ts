/**
 * Clone / download a GitHub MCP server into plugin-data and infer a stdio launch.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { AuxiliaryError } from '../../errors.ts'
import { fetchGithubRepoArchive } from '../instructions-skills/github-archive.ts'
import { parseGitSkillSource } from '../instructions-skills/git-source.ts'
import { removePathRobust } from '../instructions-skills/remove-path.ts'
import { mcpServerInstallDir } from './paths.ts'
import type { McpStdioConfig } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function inferStdioFromPackageJson(
  installDir: string,
  override?: { readonly command?: string, readonly args?: readonly string[] },
): McpStdioConfig {
  if (override?.command !== undefined && override.command.trim() !== '') {
    return {
      transport: 'stdio',
      command: override.command.trim(),
      args: override.args !== undefined ? [...override.args] : [],
      env: {},
      cwd: installDir,
    }
  }

  const pkgPath = join(installDir, 'package.json')
  if (!existsSync(pkgPath)) {
    return {
      transport: 'stdio',
      command: 'npx',
      args: ['.'],
      env: {},
      cwd: installDir,
    }
  }

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as unknown
    if (isRecord(pkg)) {
      const bin = pkg.bin
      if (typeof bin === 'string' && bin.trim() !== '') {
        return {
          transport: 'stdio',
          command: process.execPath,
          args: [join(installDir, bin)],
          env: {},
          cwd: installDir,
        }
      }
      if (isRecord(bin)) {
        const first = Object.values(bin).find(
          (value): value is string => typeof value === 'string' && value.trim() !== '',
        )
        if (first !== undefined) {
          return {
            transport: 'stdio',
            command: process.execPath,
            args: [join(installDir, first)],
            env: {},
            cwd: installDir,
          }
        }
      }
      if (typeof pkg.main === 'string' && pkg.main.trim() !== '') {
        return {
          transport: 'stdio',
          command: process.execPath,
          args: [join(installDir, pkg.main)],
          env: {},
          cwd: installDir,
        }
      }
    }
  } catch {
    // fall through
  }

  return {
    transport: 'stdio',
    command: 'npx',
    args: ['.'],
    env: {},
    cwd: installDir,
  }
}

export async function installMcpServerFromGit(options: {
  readonly rootDir: string
  readonly id: string
  readonly source: string
  readonly signal: AbortSignal
  readonly force: boolean
  readonly command?: string
  readonly args?: readonly string[]
}): Promise<{ readonly installDir: string, readonly transport: McpStdioConfig, readonly label: string }> {
  const parsed = parseGitSkillSource(options.source)
  const installDir = mcpServerInstallDir(options.rootDir, options.id)
  if (existsSync(installDir)) {
    if (!options.force) {
      throw new AuxiliaryError('FILE_EDIT_FAILED', `MCP install dir already exists: ${installDir}`)
    }
    removePathRobust(installDir)
  }

  mkdirSync(join(options.rootDir, 'mcp-servers'), { recursive: true })
  const staging = `${installDir}.staging.${process.pid}`
  try {
    if (existsSync(staging)) removePathRobust(staging)
    mkdirSync(staging, { recursive: true })

    if (parsed.github === null) {
      throw new AuxiliaryError(
        'FILE_EDIT_FAILED',
        'Only GitHub sources are supported for MCP connector install in v1',
      )
    }

    const repoDir = await fetchGithubRepoArchive({
      owner: parsed.github.owner,
      repo: parsed.github.repo,
      workDir: staging,
      signal: options.signal,
    })

    options.signal.throwIfAborted()
    let contentRoot = repoDir
    if (parsed.subpath !== null) {
      const nested = join(repoDir, parsed.subpath)
      if (!existsSync(nested)) {
        throw new AuxiliaryError('FILE_EDIT_FAILED', `Subpath not found in repo: ${parsed.subpath}`)
      }
      contentRoot = nested
    }

    mkdirSync(join(options.rootDir, 'mcp-servers'), { recursive: true })
    if (contentRoot !== repoDir) {
      const nestedStaging = `${installDir}.nested.${process.pid}`
      renameSync(contentRoot, nestedStaging)
      removePathRobust(staging)
      renameSync(nestedStaging, installDir)
    } else {
      renameSync(repoDir, installDir)
      try {
        removePathRobust(staging)
      } catch {
        // best-effort
      }
    }
  } catch (error) {
    try {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
    } catch {
      // ignore
    }
    try {
      if (existsSync(installDir)) removePathRobust(installDir)
    } catch {
      // ignore
    }
    if (error instanceof AuxiliaryError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new AuxiliaryError('FILE_EDIT_FAILED', `MCP GitHub install failed: ${detail}`)
  }

  const transport = inferStdioFromPackageJson(installDir, {
    command: options.command,
    args: options.args,
  })
  return { installDir, transport, label: parsed.label }
}
