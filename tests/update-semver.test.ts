import { describe, expect, it } from 'vitest'
import { isNewerVersion } from '../src/host/update/semver.ts'

describe('isNewerVersion', () => {
  it('is true only when latest > current', () => {
    expect(isNewerVersion('0.2.1', '0.2.0')).toBe(true)
    expect(isNewerVersion('0.3.0', '0.2.9')).toBe(true)
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false)
    expect(isNewerVersion('0.1.9', '0.2.0')).toBe(false)
  })

  it('treats invalid versions as not newer', () => {
    expect(isNewerVersion('', '0.2.0')).toBe(false)
    expect(isNewerVersion('latest', '0.2.0')).toBe(false)
  })
})
