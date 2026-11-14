import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('share-fetch guest script', () => {
  it('attaches Bearer from localStorage userToken for history API parity', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/client/web-chat-bridge/share-fetch.ts'),
      'utf8',
    )
    expect(source).toContain("localStorage.getItem('userToken')")
    expect(source).toContain('Bearer ')
    expect(source).toContain('authorization')
  })
})
