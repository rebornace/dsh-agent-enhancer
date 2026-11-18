import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  assertInsideAllowedRoots,
  cwdStorageKey,
  isInsideRoot,
  normalizeRootPath,
} from '../src/host/extra-folders/paths.ts'

describe('extra-folders path fence', () => {
  const primary = resolve('/workspace/project')
  const extra = resolve('/data/shared')
  const other = resolve('/tmp/outside')

  it('allows the primary root and its descendants', () => {
    expect(isInsideRoot(primary, primary)).toBe(true)
    expect(isInsideRoot(primary, resolve(primary, 'src', 'a.ts'))).toBe(true)
  })

  it('allows attached roots and rejects outsiders', () => {
    expect(() => assertInsideAllowedRoots(primary, [extra], resolve(extra, 'lib.ts'))).not.toThrow()
    expect(() => assertInsideAllowedRoots(primary, [extra], resolve(primary, 'a.ts'))).not.toThrow()
    expect(() => assertInsideAllowedRoots(primary, [extra], other)).toThrow(/outside/)
  })

  it('rejects path traversal out of an attached root', () => {
    const escaped = resolve(extra, '..', 'secret.txt')
    expect(() => assertInsideAllowedRoots(primary, [extra], escaped)).toThrow(/outside/)
  })

  it('normalizes and hashes cwd keys stably', () => {
    expect(normalizeRootPath(`${primary}/`)).toBe(primary)
    expect(cwdStorageKey(primary)).toBe(cwdStorageKey(`${primary}/`))
    expect(cwdStorageKey(primary)).toMatch(/^[a-f0-9]{32}$/)
  })
})
