import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

const SHARED_RUNTIME = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-typert-registry',
  'react',
  'react-dom',
] as const

/**
 * Peers accept every 0.2.2 prerelease from rc.2 on, so the plugin loads on a
 * Desktop that has not taken the latest candidate yet; devDeps stay pinned to
 * the newest one we build and test against. Exact-mirroring peers is also fine
 * for packages with their own version line (cordis).
 */
const PEER_RANGE = '>=0.2.2-rc.2 <0.3.0-0'

it('shares host runtime packages through peer and dev dependencies', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
    peerDependencies: Record<string, string>
  }
  for (const name of SHARED_RUNTIME) {
    const dev = manifest.devDependencies[name]
    const peer = manifest.peerDependencies[name]
    expect(peer, `${name} peer`).toBeDefined()
    // Dev pins a concrete build; no `^`, `latest` or `workspace:` drift.
    expect(dev, `${name} dev`).toMatch(/^\d+\.\d+\.\d+/)
    expect(
      peer === dev || peer === PEER_RANGE,
      `${name} peer must mirror dev (${dev}) or accept ${PEER_RANGE}`,
    ).toBe(true)
    expect(manifest.dependencies[name], `${name} must not be duplicated`).toBeUndefined()
  }
  // Host Config + RPC codecs are build externals; the profile pack must ship
  // concrete copies (Desktop does not seed these into plugin resolution).
  expect(manifest.dependencies['@deepseek-ai/schemastery']).toBe('3.19.0')
  expect(manifest.dependencies.zod).toBeDefined()
})
