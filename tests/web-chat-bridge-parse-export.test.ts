import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { parseWebChatExport } from '../src/host/web-chat-bridge/parse-export.ts'
import { WEB_CHAT_MAX_MESSAGES, WEB_CHAT_MAX_TEXT_BYTES } from '../src/host/web-chat-bridge/limits.ts'

function createZip(files: Array<{ name: string; data: Buffer; method?: 0 | 8 }>): Buffer {
  const chunks: Buffer[] = []
  for (const file of files) {
    const method = file.method ?? 0
    const nameBuf = Buffer.from(file.name, 'utf8')
    const payload = method === 8 ? deflateRawSync(file.data) : file.data
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt32LE(0, 10)
    header.writeUInt32LE(payload.length, 18)
    header.writeUInt32LE(file.data.length, 22)
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(0, 28)
    chunks.push(header, nameBuf, payload)
  }
  return Buffer.concat(chunks)
}

describe('parseWebChatExport', () => {
  it('parses simple markdown turns', () => {
    const md = `# 插件灵感\n\n## User\n这个想法能不能做成插件？\n\n## Assistant\n可以。先定页签。\n`
    const t = parseWebChatExport({ filename: 'a.md', bytes: Buffer.from(md, 'utf8') })
    expect(t.title).toContain('插件')
    expect(t.partial).toBe(false)
    expect(t.turns).toEqual([
      { role: 'user', text: '这个想法能不能做成插件？' },
      { role: 'assistant', text: '可以。先定页签。' },
    ])
    expect(t.source.kind).toBe('official-export')
  })

  it('rejects oversized payloads', () => {
    const big = 'x'.repeat(WEB_CHAT_MAX_TEXT_BYTES + 1)
    expect(() => parseWebChatExport({
      filename: 'big.txt',
      bytes: Buffer.from(big, 'utf8'),
    })).toThrow(/too.?large|limit/i)
  })

  it('rejects more than max messages', () => {
    const lines = Array.from({ length: WEB_CHAT_MAX_MESSAGES + 1 }, (_, i) =>
      i % 2 === 0 ? `## User\nu${i}` : `## Assistant\na${i}`).join('\n\n')
    expect(() => parseWebChatExport({
      filename: 'many.md',
      bytes: Buffer.from(lines, 'utf8'),
    })).toThrow(/5000|message/i)
  })

  it('parses json export with messages array', () => {
    const json = JSON.stringify({
      title: 'JSON chat',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
    })
    const t = parseWebChatExport({ filename: 'export.json', bytes: Buffer.from(json, 'utf8') })
    expect(t.title).toBe('JSON chat')
    expect(t.turns).toEqual([
      { role: 'user', text: 'Hello' },
      { role: 'assistant', text: 'Hi there' },
    ])
    expect(t.source.kind).toBe('official-export')
  })

  it('throws unrecognized-export for unknown binary', () => {
    expect(() => parseWebChatExport({
      filename: 'data.bin',
      bytes: Buffer.from([0, 1, 2, 3]),
    })).toThrow(/unrecognized-export/i)
  })

  it('throws when export has no message turns', () => {
    expect(() => parseWebChatExport({
      filename: 'empty.md',
      bytes: Buffer.from('# Title only\n\n', 'utf8'),
    })).toThrow(/no messages found/i)
    expect(() => parseWebChatExport({
      filename: 'empty.json',
      bytes: Buffer.from(JSON.stringify({ title: 'x', messages: [] }), 'utf8'),
    })).toThrow(/no messages found/i)
  })

  it('parses markdown inside a zip archive', () => {
    const md = `# Zip title\n\n## User\nfrom zip\n\n## Assistant\nok\n`
    const zip = createZip([{ name: 'chat.md', data: Buffer.from(md, 'utf8') }])
    const t = parseWebChatExport({ filename: 'export.zip', bytes: zip })
    expect(t.title).toContain('Zip')
    expect(t.turns).toEqual([
      { role: 'user', text: 'from zip' },
      { role: 'assistant', text: 'ok' },
    ])
  })

  it('decompresses only the picked zip entry', () => {
    const md = `## User\nzip ok\n\n## Assistant\nfrom zip`
    const zip = createZip([
      {
        name: 'trap.json',
        data: Buffer.from('{ broken', 'utf8'),
        method: 8,
      },
      { name: 'chat.md', data: Buffer.from(md, 'utf8'), method: 0 },
    ])
    const t = parseWebChatExport({ filename: 'export.zip', bytes: zip })
    expect(t.turns[0]?.text).toBe('zip ok')
  })

  it('inflates only the picked deflate zip entry', () => {
    const md = `## User\nonly one\n\n## Assistant\ninflate`
    const zip = createZip([
      {
        name: 'trap.json',
        data: Buffer.from('{ broken deflate payload', 'utf8'),
        method: 8,
      },
      { name: 'chat.md', data: Buffer.from(md, 'utf8'), method: 8 },
    ])
    const t = parseWebChatExport({ filename: 'export.zip', bytes: zip })
    expect(t.turns[0]?.text).toBe('only one')
  })
})
