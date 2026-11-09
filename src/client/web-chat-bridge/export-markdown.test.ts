import { describe, expect, it } from 'vitest'
import {
  formatWebChatExportMarkdown,
  webChatExportFilename,
} from './export-markdown.ts'

describe('formatWebChatExportMarkdown', () => {
  it('emits section headers parse-export can re-import', () => {
    const markdown = formatWebChatExportMarkdown({
      title: 'Hello',
      partial: false,
      turns: [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'hello there' },
      ],
      source: {
        kind: 'rendered-capture',
        capturedAt: '2026-11-09T00:00:00.000Z',
      },
    })
    expect(markdown).toContain('# Hello')
    expect(markdown).toContain('## User')
    expect(markdown).toContain('hi')
    expect(markdown).toContain('## Assistant')
    expect(markdown).toContain('hello there')
  })
})

describe('webChatExportFilename', () => {
  it('strips unsafe path characters', () => {
    const name = webChatExportFilename('a/b:c*', new Date('2026-11-09T12:34:56.000Z'))
    expect(name).toMatch(/^a_b_c_-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/)
  })
})
