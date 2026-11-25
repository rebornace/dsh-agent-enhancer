import { describe, expect, it } from 'vitest'
import { encodeQr, qrModulesPath } from '../src/client/remote/qr.ts'

/**
 * Correctness was checked once against a real decoder (jsQR) for every ECC
 * level across versions 1–20, including UTF-8 and the over-capacity error.
 * jsQR is not a project dependency, so these tests pin the structure that
 * makes those decoded runs possible.
 */
describe('encodeQr', () => {
  it('builds the expected size for the chosen version', () => {
    const matrix = encodeQr('https://liteapp.weixin.qq.com/q/7GiVpJ?type=3')
    expect(matrix.version).toBeGreaterThanOrEqual(1)
    expect(matrix.size).toBe(17 + 4 * matrix.version)
    expect(matrix.rows).toHaveLength(matrix.size)
    for (const row of matrix.rows) expect(row).toHaveLength(matrix.size)
  })

  it('draws the three finder patterns and their separators', () => {
    const { rows, size } = encodeQr('finder check')
    const finderAt = (top: number, left: number) => {
      for (let y = 0; y < 7; y += 1) {
        for (let x = 0; x < 7; x += 1) {
          const ring = y === 0 || y === 6 || x === 0 || x === 6
          const core = y >= 2 && y <= 4 && x >= 2 && x <= 4
          expect(rows[top + y]?.[left + x]).toBe(ring || core)
        }
      }
      // Separator: the module just outside the finder is light (when inside).
      if (top + 7 < size) expect(rows[top + 7]?.[left]).toBe(false)
      if (left + 7 < size) expect(rows[top]?.[left + 7]).toBe(false)
    }
    finderAt(0, 0)
    finderAt(0, size - 7)
    finderAt(size - 7, 0)
  })

  it('alternates the timing patterns', () => {
    const { rows, size } = encodeQr('timing check')
    for (let i = 8; i < size - 8; i += 1) {
      expect(rows[6]?.[i]).toBe(i % 2 === 0)
      expect(rows[i]?.[6]).toBe(i % 2 === 0)
    }
  })

  it('is deterministic and grows the version with the payload', () => {
    const a = encodeQr('same input')
    const b = encodeQr('same input')
    expect(a.rows).toEqual(b.rows)

    const long = encodeQr(`https://liteapp.weixin.qq.com/q/${'a'.repeat(400)}`)
    expect(long.version).toBeGreaterThan(a.version)
  })

  it('rejects empty or oversized payloads instead of emitting a broken code', () => {
    expect(() => encodeQr('')).toThrow()
    expect(() => encodeQr('x'.repeat(5000))).toThrow(/太长/)
  })

  it('renders a quiet zone and only dark modules in the path', () => {
    const matrix = encodeQr('path check')
    const path = qrModulesPath(matrix, 4)
    const dark = matrix.rows.flat().filter(Boolean).length
    expect(path.split('M')).toHaveLength(dark + 1)
    // The finder's top-left dark module sits at quietZone offset.
    expect(path).toContain('M4 4h1v1h-1z')
  })
})
