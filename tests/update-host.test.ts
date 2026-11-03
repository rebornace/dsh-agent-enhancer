import { describe, expect, it, vi } from 'vitest'
import { fetchLatestVersion } from '../src/host/update/registry.ts'
import { detectInstallKind } from '../src/host/update/install-kind.ts'
import {
  isStrictVersion,
  pluginAddCommand,
  probeDsh,
  resolveCanAutoApply,
  runPluginAdd,
  type SpawnLike,
} from '../src/host/update/cli.ts'
import {
  applyPluginUpdate,
  checkPluginUpdate,
  resolveDesktopProfileDir,
} from '../src/host/update/check.ts'
import { PACKAGE_NAME } from '../src/identity.ts'
import { mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('fetchLatestVersion', () => {
  it('reads dist-tags.latest from registry json', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      'dist-tags': { latest: '0.2.1' },
    }), { status: 200 }))
    await expect(fetchLatestVersion(PACKAGE_NAME, {
      fetch: fetchImpl,
      currentVersion: '0.2.0',
      timeoutMs: 1000,
      sources: [{ kind: 'npm-dist-tag', baseUrl: 'https://registry.example.test' }],
    })).resolves.toBe('0.2.1')
    expect(fetchImpl).toHaveBeenCalled()
    const firstCall = fetchImpl.mock.calls[0] as unknown as readonly [RequestInfo | URL] | undefined
    expect(String(firstCall?.[0])).toContain(`registry.example.test/${PACKAGE_NAME}`)
  })

  it('falls back to the next source when the first fails', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('primary.example')) return new Response('nope', { status: 500 })
      return new Response(JSON.stringify({ version: '0.3.0' }), { status: 200 })
    })
    await expect(fetchLatestVersion(PACKAGE_NAME, {
      fetch: fetchImpl,
      currentVersion: '0.2.0',
      timeoutMs: 1000,
      sources: [
        { kind: 'npm-dist-tag', baseUrl: 'https://primary.example' },
        { kind: 'package-json', url: 'https://cdn.example/package.json' },
      ],
    })).resolves.toBe('0.3.0')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('skips non x.y.z latest tags and keeps probing', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('mirror.example')) {
        return new Response(JSON.stringify({ 'dist-tags': { latest: '0.0.0-stage' } }), { status: 200 })
      }
      return new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 })
    })
    await expect(fetchLatestVersion(PACKAGE_NAME, {
      fetch: fetchImpl,
      currentVersion: '0.2.0',
      timeoutMs: 1000,
      sources: [
        { kind: 'npm-dist-tag', baseUrl: 'https://mirror.example' },
        { kind: 'package-json', url: 'https://cdn.example/package.json' },
      ],
    })).resolves.toBe('0.2.0')
  })

  it('returns null on non-ok or missing tag', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(fetchLatestVersion(PACKAGE_NAME, {
      fetch: fetchImpl,
      currentVersion: '0.2.0',
      timeoutMs: 1000,
      sources: [{ kind: 'npm-dist-tag', baseUrl: 'https://registry.example.test' }],
    })).resolves.toBeNull()
  })
})

describe('detectInstallKind', () => {
  it('detects symlink as link and plain dir as npm', () => {
    const root = join(tmpdir(), `dsh-update-kind-${Date.now()}`)
    const nm = join(root, 'node_modules', PACKAGE_NAME)
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    mkdirSync(join(root, 'real-pkg'), { recursive: true })
    writeFileSync(join(root, 'real-pkg', 'package.json'), '{}')
    try {
      symlinkSync(join(root, 'real-pkg'), nm, 'junction')
      expect(detectInstallKind(root)).toBe('link')
      rmSync(nm, { force: true, recursive: true })
      mkdirSync(nm, { recursive: true })
      writeFileSync(join(nm, 'package.json'), '{}')
      expect(detectInstallKind(root)).toBe('npm')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('returns unknown when package folder missing', () => {
    expect(detectInstallKind(join(tmpdir(), 'no-such-profile-xyz'))).toBe('unknown')
  })
})

describe('cli helpers', () => {
  it('builds pinned add command', () => {
    expect(pluginAddCommand('0.2.1')).toBe(
      `dsh plugin --profile desktop add ${PACKAGE_NAME}@0.2.1`,
    )
  })

  it('allows auto apply only for npm + dsh available', () => {
    expect(resolveCanAutoApply({ installKind: 'npm', dshAvailable: true })).toBe(true)
    expect(resolveCanAutoApply({ installKind: 'npm', dshAvailable: false })).toBe(false)
    expect(resolveCanAutoApply({ installKind: 'link', dshAvailable: true })).toBe(false)
    expect(resolveCanAutoApply({ installKind: 'unknown', dshAvailable: true })).toBe(false)
  })
})

describe('dsh spawn hardening', () => {
  const throwingSpawn: SpawnLike = () => {
    throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' })
  }

  it('probeDsh returns false when spawn throws synchronously', async () => {
    await expect(probeDsh(throwingSpawn)).resolves.toBe(false)
  })

  it('runPluginAdd does not throw when spawn throws synchronously', async () => {
    const result = await runPluginAdd('0.2.1', throwingSpawn)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('EINVAL')
  })

  it('runPluginAdd rejects non-strict versions without spawning', async () => {
    const spawnFn = vi.fn()
    for (const bad of ['latest', '0.2.1-beta.1', '0.2.1 & calc', '1.2', '']) {
      const result = await runPluginAdd(bad, spawnFn as unknown as SpawnLike)
      expect(result.ok).toBe(false)
    }
    expect(spawnFn).not.toHaveBeenCalled()
    expect(isStrictVersion('10.20.30')).toBe(true)
    expect(isStrictVersion('1.2.3\n')).toBe(false)
  })

  it('spawns `dsh` and uses a shell on win32 only', async () => {
    const spawnFn = vi.fn(throwingSpawn)
    await probeDsh(spawnFn)
    const [command, args, options] = spawnFn.mock.calls[0]!
    expect(command).toBe('dsh')
    expect(args).toEqual(['--version'])
    expect(options?.shell === true).toBe(process.platform === 'win32')
  })

  it('checkPluginUpdate still returns latest when the dsh probe rejects', async () => {
    const result = await checkPluginUpdate({
      currentVersion: '0.2.0',
      fetchLatest: async () => '0.2.1',
      detectKind: () => 'npm',
      dshAvailable: async () => { throw new Error('boom') },
      profileDir: '/fake',
    })
    expect(result.latest).toBe('0.2.1')
    expect(result.canAutoApply).toBe(false)
  })
})

describe('checkPluginUpdate', () => {
  it('marks update available and canAutoApply for npm + dsh', async () => {
    const result = await checkPluginUpdate({
      currentVersion: '0.2.0',
      fetchLatest: async () => '0.2.1',
      detectKind: () => 'npm',
      dshAvailable: async () => true,
      profileDir: '/fake',
    })
    expect(result).toEqual({
      current: '0.2.0',
      latest: '0.2.1',
      updateAvailable: true,
      installKind: 'npm',
      canAutoApply: true,
      command: `dsh plugin --profile desktop add ${PACKAGE_NAME}@0.2.1`,
    })
  })

  it('disables auto apply for link even when newer', async () => {
    const result = await checkPluginUpdate({
      currentVersion: '0.2.0',
      fetchLatest: async () => '0.3.0',
      detectKind: () => 'link',
      dshAvailable: async () => true,
      profileDir: '/fake',
    })
    expect(result.canAutoApply).toBe(false)
    expect(result.updateAvailable).toBe(true)
  })

  it('keeps canAutoApply true for npm+dsh when already on latest', async () => {
    const result = await checkPluginUpdate({
      currentVersion: '0.2.1',
      fetchLatest: async () => '0.2.1',
      detectKind: () => 'npm',
      dshAvailable: async () => true,
      profileDir: '/fake',
    })
    expect(result.updateAvailable).toBe(false)
    expect(result.canAutoApply).toBe(true)
  })
})

describe('resolveDesktopProfileDir', () => {
  it('uses DSH_HOME when set', () => {
    const dshHome = join('/custom', 'dsh')
    expect(
      resolveDesktopProfileDir({ DSH_HOME: dshHome } as NodeJS.ProcessEnv, '/home/user'),
    ).toBe(join(dshHome, 'profiles', 'desktop'))
  })

  it('falls back to home/.dsh', () => {
    const home = join('/home', 'user')
    expect(resolveDesktopProfileDir({}, home)).toBe(join(home, '.dsh', 'profiles', 'desktop'))
  })
})

describe('applyPluginUpdate', () => {
  it('does not spawn when canAutoApply is false', async () => {
    const run = vi.fn()
    const result = await applyPluginUpdate({
      check: {
        current: '0.2.0',
        latest: '0.2.1',
        updateAvailable: true,
        installKind: 'link',
        canAutoApply: false,
        command: `dsh plugin --profile desktop add ${PACKAGE_NAME}@0.2.1`,
      },
      runAdd: run,
      messages: {
        linkBlocked: 'link',
        success: 'restart',
        failed: 'failed',
        noUpdate: 'none',
      },
    })
    expect(run).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.message).toBe('link')
    expect(result.command).toContain(`${PACKAGE_NAME}@0.2.1`)
  })

  it('spawns and reports success', async () => {
    const run = vi.fn(async () => ({ ok: true, detail: '' }))
    const result = await applyPluginUpdate({
      check: {
        current: '0.2.0',
        latest: '0.2.1',
        updateAvailable: true,
        installKind: 'npm',
        canAutoApply: true,
        command: `dsh plugin --profile desktop add ${PACKAGE_NAME}@0.2.1`,
      },
      runAdd: run,
      messages: {
        linkBlocked: 'link',
        success: 'restart',
        failed: 'failed',
        noUpdate: 'none',
      },
    })
    expect(run).toHaveBeenCalledWith('0.2.1')
    expect(result).toEqual({ ok: true, message: 'restart' })
  })

  it('reports failed when runAdd returns not ok', async () => {
    const run = vi.fn(async () => ({ ok: false, detail: 'spawn error' }))
    const command = `dsh plugin --profile desktop add ${PACKAGE_NAME}@0.2.1`
    const result = await applyPluginUpdate({
      check: {
        current: '0.2.0',
        latest: '0.2.1',
        updateAvailable: true,
        installKind: 'npm',
        canAutoApply: true,
        command,
      },
      runAdd: run,
      messages: {
        linkBlocked: 'link',
        success: 'restart',
        failed: 'failed',
        noUpdate: 'none',
      },
    })
    expect(run).toHaveBeenCalledWith('0.2.1')
    expect(result).toEqual({ ok: false, message: 'failed', command })
  })
})
