import { describe, expect, it } from 'vitest'
import {
  coverageAffordance,
  previewMessageRole,
  truncatePreviewText,
} from '../src/client/rollback/format.ts'

describe('rollback preview format', () => {
  it('collapses whitespace and truncates long preview text', () => {
    expect(truncatePreviewText('  hello\n\nworld  ')).toBe('hello world')
    expect(truncatePreviewText('x'.repeat(160)).endsWith('…')).toBe(true)
    expect(truncatePreviewText('x'.repeat(160)).length).toBe(140)
  })

  it('maps event types to readable roles', () => {
    expect(previewMessageRole('user/message')).toBe('user')
    expect(previewMessageRole('assistant/message')).toBe('assistant')
    expect(previewMessageRole('tool/result')).toBe('tool')
    expect(previewMessageRole('system/message')).toBe('system')
    expect(previewMessageRole('developer/message')).toBe('system')
    expect(previewMessageRole('turn/start')).toBe('other')
  })

  it('classifies coverage affordances for restore buttons', () => {
    expect(coverageAffordance(undefined)).toBe('unknown')
    expect(coverageAffordance({ coverage: 'complete', fileCount: 2 })).toBe('files')
    expect(coverageAffordance({ coverage: 'partial', fileCount: 2 })).toBe('partial')
    expect(coverageAffordance({ coverage: 'complete', fileCount: 0 })).toBe('conversation')
    expect(coverageAffordance({ coverage: 'partial', fileCount: 0 })).toBe('partial')
  })
})
