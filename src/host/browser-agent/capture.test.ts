import { describe, expect, it } from 'vitest'
import { CaptureBuffer, redactUrl } from './capture.ts'
import type { CaptureEntry } from './capture.ts'

const net = (url: string, tabId = 1): CaptureEntry => ({
  kind: 'request',
  at: 1,
  tabId,
  method: 'GET',
  url,
  resourceType: 'document',
  status: 200,
})

const log = (text: string, tabId = 1): CaptureEntry => ({
  kind: 'console',
  at: 2,
  tabId,
  level: 'error',
  text,
})

describe('redactUrl', () => {
  it('masks secret-looking query values and drops the fragment', () => {
    const out = redactUrl('https://example.com/cb?code=abc123&page=2&token=zzz#frag')
    expect(out).toBe('https://example.com/cb?code=***&page=2&token=***')
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('zzz')
  })

  it('strips userinfo but keeps the path', () => {
    expect(redactUrl('https://user:pw@example.com/a/b')).toBe('https://example.com/a/b')
  })

  it('passes odd inputs through with a hard length cap', () => {
    expect(redactUrl('about:blank')).toBe('about:blank')
    const long = `data:text/html,${'x'.repeat(400)}`
    expect(redactUrl(long).length).toBeLessThanOrEqual(301)
  })
})

describe('CaptureBuffer', () => {
  it('keeps only the newest entries past the cap', () => {
    const buffer = new CaptureBuffer(3)
    for (let i = 0; i < 5; i += 1) buffer.push(net(`https://example.com/${i}`))
    const { entries, dropped } = buffer.read('network')
    expect(entries.map(entry => entry.kind === 'request' ? entry.url : '')).toEqual([
      'https://example.com/2',
      'https://example.com/3',
      'https://example.com/4',
    ])
    expect(dropped).toBe(2)
  })

  it('separates network from console', () => {
    const buffer = new CaptureBuffer()
    buffer.push(net('https://example.com/api'))
    buffer.push(log('boom'))
    expect(buffer.read('network').entries).toHaveLength(1)
    expect(buffer.read('console').entries).toHaveLength(1)
    expect(buffer.read('all').entries).toHaveLength(2)
  })

  it('returns the newest entries and honours limit', () => {
    const buffer = new CaptureBuffer()
    for (let i = 0; i < 10; i += 1) buffer.push(net(`https://example.com/${i}`))
    const { entries } = buffer.read('network', { limit: 3 })
    expect(entries.map(entry => entry.kind === 'request' ? entry.url : '')).toEqual([
      'https://example.com/7',
      'https://example.com/8',
      'https://example.com/9',
    ])
  })

  it('only clears what it returned', () => {
    const buffer = new CaptureBuffer()
    buffer.push(net('https://a/1'))
    buffer.push(log('keep me'))
    const { entries } = buffer.read('network', { clear: true })
    expect(entries).toHaveLength(1)
    expect(buffer.size).toBe(1)
    expect(buffer.read('console').entries[0]).toMatchObject({ text: 'keep me' })
  })
})
