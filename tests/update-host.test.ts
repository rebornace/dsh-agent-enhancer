import { describe, expect, it, vi } from 'vitest'
import { fetchLatestVersion } from '../src/host/update/registry.ts'
import { detectInstallKind } from '../src/host/update/install-kind.ts'
import { pluginAddCommand, resolveCanAutoApply } from '../src/host/update/cli.ts'
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
    })).resolves.toBe('0.2.1')
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('returns null on non-ok or missing tag', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(fetchLatestVersion(PACKAGE_NAME, {
      fetch: fetchImpl,
      currentVersion: '0.2.0',
      timeoutMs: 1000,
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
