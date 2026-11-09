import { describe, expect, it } from 'vitest'
import { analyzeWebChatExport, parseWebChatExport } from './parse-export.ts'

function utf8(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

describe('analyzeWebChatExport', () => {
  it('lists multiple chats from a chats[] JSON export', () => {
    const payload = {
      chats: [
        {
          title: 'Alpha',
          messages: [
            { role: 'user', content: 'hello alpha' },
            { role: 'assistant', content: 'hi alpha' },
          ],
        },
        {
          title: 'Beta',
          messages: [
            { role: 'user', content: 'hello beta' },
            { role: 'assistant', content: 'hi beta' },
          ],
        },
      ],
    }
    const result = analyzeWebChatExport({
      filename: 'export.json',
      bytes: utf8(JSON.stringify(payload)),
    })
    expect(result.truncated).toBe(false)
    expect(result.items).toHaveLength(2)
    expect(result.items[0]?.title).toBe('Alpha')
    expect(result.items[1]?.title).toBe('Beta')
    expect(result.items[0]?.turnCount).toBe(2)
    expect(result.items[0]?.preview).toContain('hello alpha')
    expect(result.items[0]?.transcript?.turns[0]?.text).toBe('hello alpha')
  })

  it('lists a top-level JSON array of conversations', () => {
    const payload = [
      {
        name: 'One',
        messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
      },
      {
        name: 'Two',
        messages: [{ role: 'user', content: 'c' }, { role: 'assistant', content: 'd' }],
      },
    ]
    const result = analyzeWebChatExport({
      filename: 'history.json',
      bytes: utf8(JSON.stringify(payload)),
    })
    expect(result.items.map(item => item.title)).toEqual(['One', 'Two'])
  })

  it('keeps a single markdown chat as one catalog item', () => {
    const markdown = [
      '# Solo',
      '',
      '## User',
      '',
      'ping',
      '',
      '## Assistant',
      '',
      'pong',
      '',
    ].join('\n')
    const result = analyzeWebChatExport({
      filename: 'solo.md',
      bytes: utf8(markdown),
    })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.title).toBe('Solo')
    expect(parseWebChatExport({
      filename: 'solo.md',
      bytes: utf8(markdown),
    }).title).toBe('Solo')
  })

  it('splits multi-heading markdown into separate conversations', () => {
    const markdown = [
      '# First',
      '',
      '## User',
      '',
      'one',
      '',
      '## Assistant',
      '',
      'reply one',
      '',
      '# Second',
      '',
      '## User',
      '',
      'two',
      '',
      '## Assistant',
      '',
      'reply two',
      '',
    ].join('\n')
    const result = analyzeWebChatExport({
      filename: 'multi.md',
      bytes: utf8(markdown),
    })
    expect(result.items.map(item => item.title)).toEqual(['First', 'Second'])
  })
})
