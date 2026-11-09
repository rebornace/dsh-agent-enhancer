import { describe, expect, it } from 'vitest'
import { decodeWindowsPickerPathBase64 } from './pick.ts'

describe('decodeWindowsPickerPathBase64', () => {
  it('round-trips Chinese folder names that used to mojibake under console ANSI', () => {
    const path = 'C:\\Users\\Administrator\\Desktop\\新建文件夹'
    const encoded = Buffer.from(path, 'utf8').toString('base64')
    expect(decodeWindowsPickerPathBase64(encoded)).toBe(path)
  })

  it('returns null for empty / invalid output', () => {
    expect(decodeWindowsPickerPathBase64('')).toBeNull()
    expect(decodeWindowsPickerPathBase64('   ')).toBeNull()
  })
})
