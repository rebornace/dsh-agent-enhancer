import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Build once before the suite starts. Tracked (unlike the older copy under
 * `tests/`, which git ignores) so a fresh clone and CI can run `pnpm test`
 * without a missing-globalSetup failure. Skipped when `lib/` is already built.
 */
export default async function setup(): Promise<void> {
  if (existsSync(join(process.cwd(), 'lib', 'index.js'))) return
  await execFileAsync(process.execPath, ['esbuild.config.mjs'])
}
