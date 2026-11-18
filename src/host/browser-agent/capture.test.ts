import { describe, expect, it } from 'vitest'
import { CaptureBuffer, redactText, redactUrl } from './capture.ts'
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

describe('redactText', () => {
  it('masks tokens inside console messages', () => {
    const text = 'Failed to load resource: the server responded with a status of 404 () '
      + '(https://example.com/probe?token=dsh-secret&page=2:0)'
    const out = redactText(text)
    expect(out).not.toContain('dsh-secret')
    expect(out).toContain('token=***')
    expect(out.endsWith(')')).toBe(true)
  })

  it('masks every URL in a message and leaves plain text alone', () => {
    const out = redactText('a https://x.test/?code=abc b https://y.test/?session=zzz c')
    expect(out).not.toContain('abc')
    expect(out).not.toContain('zzz')
    expect(out.startsWith('a https://x.test/?code=*** b https://y.test/?session=*** c')).toBe(true)
    expect(redactText('plain message, no links')).toBe('plain message, no links')
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

  it('scopes to one tab and reports what it skipped', () => {
    const buffer = new CaptureBuffer()
    buffer.push(net('https://a/1', 1))
    buffer.push(net('https://b/1', 2))
    buffer.push(net('https://b/2', 2))
    buffer.push(log('b log', 2))

    const mine = buffer.read('network', { tabId: 2 })
    expect(mine.entries.map(entry => (entry.kind === 'request' ? entry.url : ''))).toEqual([
      'https://b/1',
      'https://b/2',
    ])
    expect(mine.skipped).toBe(1)

    const all = buffer.read('network')
    expect(all.entries).toHaveLength(3)
    expect(all.skipped).toBe(0)

    // Clearing a scoped read leaves the other tab's entries alone.
    buffer.read('network', { tabId: 2, clear: true })
    expect(buffer.read('network', { tabId: 2 }).entries).toHaveLength(0)
    expect(buffer.read('network', { tabId: 1 }).entries).toHaveLength(1)
  })
})
