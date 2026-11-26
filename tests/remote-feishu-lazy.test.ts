import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The Feishu SDK is ~30 MB with its own HTTP and protobuf stack. It is declared
 * as a runtime dependency, externalized in the bundle, and imported only when a
 * Feishu app actually connects; a static import would load all of it on every
 * plugin start.
 */
describe('Feishu SDK stays lazy', () => {
  it('never imports the SDK at module scope', () => {
    const source = readFileSync('src/host/remote/feishu/transport.ts', 'utf8')
    expect(source).not.toMatch(/from\s+['"]@larksuiteoapi\/node-sdk['"]/)
    expect(source).toContain("import('@larksuiteoapi/node-sdk')")
  })

  it('declares the SDK as a runtime dependency', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.['@larksuiteoapi/node-sdk']).toBeDefined()
  })
})
