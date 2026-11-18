import { describe, expect, it } from 'vitest'
import { parseMcpJsonText } from '../src/host/mcp-connectors/import-mcp-json.ts'
import { createMcpConnectorsStore } from '../src/host/mcp-connectors/store.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('parseMcpJsonText', () => {
  it('parses stdio and http servers', () => {
    const parsed = parseMcpJsonText(JSON.stringify({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'x' },
        },
        remote: {
          url: 'http://127.0.0.1:3000/mcp',
          headers: { Authorization: 'Bearer t' },
        },
      },
    }))
    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.serverName).toBe('github')
    expect(parsed[0]?.transport.transport).toBe('stdio')
    expect(parsed[1]?.serverName).toBe('remote')
    expect(parsed[1]?.transport.transport).toBe('streamable-http')
  })

  it('rejects empty mcpServers', () => {
    expect(() => parseMcpJsonText('{"mcpServers":{}}')).toThrow(/no servers/i)
  })
})

describe('createMcpConnectorsStore', () => {
  it('round-trips connectors', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-connectors-'))
    const store = createMcpConnectorsStore(root)
    const now = Date.now()
    store.save([{
      id: 'mcp-1',
      serverName: 'demo',
      enabled: true,
      channel: 'manual',
      sourceLabel: null,
      transport: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'demo'],
        env: {},
        cwd: '',
      },
      createdAt: now,
      updatedAt: now,
    }])
    const loaded = store.load()
    expect(loaded.connectors).toHaveLength(1)
    expect(loaded.connectors[0]?.serverName).toBe('demo')
  })
})
