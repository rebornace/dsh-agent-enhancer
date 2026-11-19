import { describe, expect, it } from 'vitest'
import { clipDetail, stageDetail } from './labels.ts'

describe('clipDetail', () => {
  it('flattens whitespace and clips with an ellipsis', () => {
    expect(clipDetail('  a\n\n  b  ')).toBe('a b')
    const long = clipDetail('x'.repeat(200))
    expect(long.endsWith('…')).toBe(true)
    expect(long.length).toBe(80)
  })
})

describe('stageDetail', () => {
  it('keeps only the first line of a shell command', () => {
    expect(stageDetail('bash', { command: 'pnpm check\npnpm build' })).toBe('pnpm check')
    expect(stageDetail('shell', { command: 'git status && git log -1' })).toBe('git status && git log -1')
  })

  it('prefers the path for file tools', () => {
    expect(stageDetail('read', { path: 'src/app.ts' })).toBe('src/app.ts')
    expect(stageDetail('edit', { file_path: 'src/host/index.ts' })).toBe('src/host/index.ts')
  })

  it('uses urls and messages for browser tools', () => {
    expect(stageDetail('browser_navigate', { url: 'https://example.com/a' })).toBe('https://example.com/a')
    expect(stageDetail('browser_demonstrate', { message: '演示一遍导出流程' })).toBe('演示一遍导出流程')
  })

  it('falls back to the first string argument', () => {
    expect(stageDetail('custom_tool', { alpha: 1, beta: 'value' })).toBe('value')
  })

  it('returns nothing when there is nothing to say', () => {
    expect(stageDetail('noop', {})).toBeUndefined()
    expect(stageDetail('noop', null)).toBeUndefined()
  })
})
