import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  dshExecutableCandidates,
  dshFromElectronExecPath,
  isCommandMissingDetail,
  probeDsh,
  resolveCanAutoApply,
  runPluginAdd,
  type SpawnLike,
} from './cli.ts'

function fakeChild(result: {
  readonly code: number | null
  readonly error?: Error
  readonly stdout?: string
}): ChildProcess {
  const child = new EventEmitter() as ChildProcess & EventEmitter
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  Object.assign(child, { stdout, stderr })
  queueMicrotask(() => {
    if (result.error) {
      child.emit('error', result.error)
      return
    }
    if (result.stdout) stdout.emit('data', Buffer.from(result.stdout))
    child.emit('close', result.code)
  })
  return child
}

describe('dshFromElectronExecPath', () => {
  it('maps DeepSeek Harness MacOS binary to bundled cli/bin/dsh', () => {
    expect(dshFromElectronExecPath(
      '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    )).toBe(
      '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
    )
  })

  it('returns null for unrelated exec paths', () => {
    expect(dshFromElectronExecPath('/usr/local/bin/node')).toBeNull()
  })
})

describe('dshExecutableCandidates', () => {
  it('prefers DSH_CLI, then Harness-relative, Applications, then PATH name', () => {
    const candidates = dshExecutableCandidates({
      platform: 'darwin',
      home: '/Users/demo',
      execPath: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      env: { DSH_CLI: '/custom/dsh' },
    })
    expect(candidates[0]).toBe('/custom/dsh')
    expect(candidates).toContain(
      '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
    )
    expect(candidates).toContain(
      '/Users/demo/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
    )
    expect(candidates.at(-1)).toBe('dsh')
  })

  it('still ends with bare dsh on non-darwin', () => {
    expect(dshExecutableCandidates({ platform: 'linux', env: {} }).at(-1)).toBe('dsh')
  })
})

describe('isCommandMissingDetail', () => {
  it('detects spawn ENOENT messages', () => {
    expect(isCommandMissingDetail('spawn dsh ENOENT')).toBe(true)
    expect(isCommandMissingDetail('exit 1: failed')).toBe(false)
  })
})

describe('probeDsh', () => {
  it('falls through PATH miss to an absolute Mac CLI candidate', async () => {
    const spawn = vi.fn<SpawnLike>((command) => {
      if (command === 'dsh') {
        return fakeChild({ code: null, error: new Error('spawn dsh ENOENT') })
      }
      return fakeChild({ code: 0, stdout: '0.2.2-rc.1\n' })
    })
    const ok = await probeDsh(spawn, {
      candidates: [
        'dsh',
        '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
      ],
      exists: (path) => path.endsWith('/dsh'),
    })
    expect(ok).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1]?.[0]).toContain('DeepSeek Harness.app')
  })
})

describe('runPluginAdd', () => {
  it('uses the first working dsh candidate', async () => {
    const spawn = vi.fn<SpawnLike>((command) => {
      if (command === 'dsh') {
        return fakeChild({ code: null, error: new Error('spawn dsh ENOENT') })
      }
      return fakeChild({ code: 0, stdout: 'ok\n' })
    })
    const result = await runPluginAdd('0.3.11', spawn, {
      candidates: ['dsh', '/tmp/bundled/dsh'],
      exists: (path) => path === '/tmp/bundled/dsh',
    })
    expect(result.ok).toBe(true)
    expect(spawn.mock.calls[1]?.[1]).toEqual([
      'plugin', '--profile', 'desktop', 'add', 'dsh-agent-enhancer@0.3.11',
    ])
  })
})

describe('resolveCanAutoApply', () => {
  it('requires npm install + available dsh', () => {
    expect(resolveCanAutoApply({ installKind: 'npm', dshAvailable: true })).toBe(true)
    expect(resolveCanAutoApply({ installKind: 'npm', dshAvailable: false })).toBe(false)
    expect(resolveCanAutoApply({ installKind: 'link', dshAvailable: true })).toBe(false)
  })
})
