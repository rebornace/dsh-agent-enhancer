import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

const SHARED_RUNTIME = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-typert-registry',
  'react',
  'react-dom',
] as const

it('shares host runtime packages through mirrored peer and dev dependencies', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
    peerDependencies: Record<string, string>
  }
  for (const name of SHARED_RUNTIME) {
    expect(manifest.peerDependencies[name], `${name} peer`).toBeDefined()
    expect(manifest.devDependencies[name], `${name} dev`).toBe(manifest.peerDependencies[name])
    expect(manifest.dependencies[name], `${name} must not be duplicated`).toBeUndefined()
  }
  expect(manifest.dependencies['@deepseek-ai/schemastery']).toBeDefined()
  expect(manifest.dependencies.zod).toBeDefined()
})
