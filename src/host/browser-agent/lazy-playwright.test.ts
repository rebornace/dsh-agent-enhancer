/**
 * Guard: playwright-core must stay a lazy, dynamic import.
 *
 * A static runtime import pulls ~350 ms of module evaluation into every Desktop
 * boot, including installs where the browser feature is switched off. Type-only
 * imports are erased by tsc/esbuild and stay allowed.
 *
 * See docs/architecture/browser-agent-browse-parity.md (D6).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

const STATIC_FROM = /from\s*['"]playwright-core['"]/
const REQUIRE_CALL = /require\(\s*['"]playwright-core['"]\s*\)/
const DYNAMIC_IMPORT = /import\(\s*['"]playwright-core['"]\s*\)/
const ENDS_STATEMENT = /from\s*['"][^'"]+['"]/

/**
 * Line numbers of runtime loads of playwright-core.
 * `import type … from 'playwright-core'` spans one or more lines and is erased
 * at build time, so those statements are skipped entirely.
 */
function runtimeLoadLines(source: string): number[] {
  const offenders: number[] = []
  let insideTypeImport = false
  source.split(/\r?\n/).forEach((line, index) => {
    if (insideTypeImport) {
      if (ENDS_STATEMENT.test(line)) insideTypeImport = false
      return
    }
    if (/^\s*import\s+type\b/.test(line)) {
      // `import type {…} from '…'` is erased at build time: skip the whole statement.
      insideTypeImport = !ENDS_STATEMENT.test(line)
      return
    }
    if (STATIC_FROM.test(line) || REQUIRE_CALL.test(line)) offenders.push(index + 1)
  })
  return offenders
}

function agentSources(): ReadonlyArray<{ readonly name: string; readonly source: string }> {
  return readdirSync(here)
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map(name => ({ name, source: readFileSync(join(here, name), 'utf8') }))
}

describe('playwright-core stays lazy', () => {
  it('has no static runtime import in the browser agent sources', () => {
    const offenders = agentSources()
      .map(file => ({ name: file.name, lines: runtimeLoadLines(file.source) }))
      .filter(file => file.lines.length > 0)
      .map(file => `${file.name}:${file.lines.join(',')}`)
    expect(offenders).toEqual([])
  })

  it('loads it through dynamic import() at launch', () => {
    const driver = agentSources().find(file => file.name === 'playwright-driver.ts')
    expect(driver).toBeDefined()
    expect(DYNAMIC_IMPORT.test(driver!.source)).toBe(true)
  })
})
