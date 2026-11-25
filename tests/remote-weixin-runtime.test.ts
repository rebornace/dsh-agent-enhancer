import type { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteRuntime } from '../src/host/remote/weixin/runtime.ts'
import type { RuntimeTransport } from '../src/host/remote/weixin/runtime.ts'
import type { WeixinCredentialStore } from '../src/host/remote/weixin/credentials.ts'
import type { LoginPoll, LoginTicket, UpdatesPage, WeixinCredentials } from '../src/host/remote/weixin/transport.ts'
import type { ChannelCapabilities } from '../src/host/remote/types.ts'

const capabilities: ChannelCapabilities = {
  buttons: false,
  editMessage: false,
  threads: false,
  media: 'none',
  markdown: false,
  maxChars: 1800,
  privateOnly: true,
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function rootDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-runtime-'))
  dirs.push(dir)
  return dir
}

function memoryStore(initial?: WeixinCredentials): WeixinCredentialStore & { value?: WeixinCredentials } {
  const store = {
    value: initial,
    async load() {
      return store.value
    },
    async save(credentials: WeixinCredentials) {
      store.value = credentials
    },
    async clear() {
      store.value = undefined
    },
  }
  return store
}

const confirmed: LoginPoll = {
  status: 'confirmed',
  credentials: { baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'bot-token', botId: 'bot-1' },
}

function transport(options: { readonly polls?: LoginPoll[]; readonly onUpdate?: () => void } = {}): RuntimeTransport {
  const polls = [...(options.polls ?? [confirmed])]
  return {
    beginLogin: vi.fn(async (): Promise<LoginTicket> => ({ ticket: 't1', qrUrl: 'https://liteapp.weixin.qq.com/q/x' })),
    pollLogin: vi.fn(async (): Promise<LoginPoll> => polls.shift() ?? { status: 'wait' }),
    getUpdates: vi.fn(async (): Promise<UpdatesPage> => {
      options.onUpdate?.()
      return { cursor: 'c1', messages: [] }
    }),
    sendText: vi.fn(async () => 1),
  }
}

function ctx() {
  const proxy = {
    sessions: {
      list: vi.fn(async () => ({ result: { ok: true, value: { items: [{ sessionId: 's1', running: true }] } } })),
      prompt: vi.fn(async () => ({ result: { ok: true, value: { accepted: true } } })),
      cancel: vi.fn(async () => ({ result: { ok: true, value: { accepted: true } } })),
    },
  }
  return {
    on: vi.fn(() => () => {}),
    get: (name: string) => (name === 'apiProxy' ? proxy : undefined),
  } as unknown as Context
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function runtime(options: {
  readonly store?: WeixinCredentialStore
  readonly transport?: RuntimeTransport
}) {
  return new RemoteRuntime({
    ctx: ctx(),
    rootDir: rootDir(),
    capabilities,
    setPaused: vi.fn(async () => {}),
    credentials: options.store ?? memoryStore(),
    createTransport: () => options.transport ?? transport(),
    now: () => 0,
    emptyPageDelayMs: 1,
  })
}

describe('RemoteRuntime', () => {
  it('starts unbound without stored credentials', async () => {
    const instance = runtime({})
    const status = await instance.start()
    expect(status.phase).toBe('unbound')
    expect(status.devices).toEqual([])
    instance.stop()
  })

  it('starts running with stored credentials and stops cleanly', async () => {
    let updates = 0
    const fake = transport({ onUpdate: () => { updates += 1 } })
    const store = memoryStore({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'token' })
    const instance = runtime({ store, transport: fake })

    const status = await instance.start()
    expect(status.phase).toBe('running')
    await until(() => updates > 0)
    instance.stop()
    expect(instance.status().phase).toBe('stopped')
  })

  it('connects after a confirmed scan and persists the credentials', async () => {
    const store = memoryStore()
    const fake = transport()
    const instance = runtime({ store, transport: fake })

    const ticket = await instance.beginLogin()
    expect(ticket.qrUrl).toContain('liteapp.weixin.qq.com')
    await until(() => instance.status().phase === 'running')
    expect(store.value?.token).toBe('bot-token')
    expect(instance.status().botId).toBe('bot-1')
    instance.stop()
  })

  it('never puts the bot token in the status payload', async () => {
    const store = memoryStore({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'secret-token' })
    const instance = runtime({ store, transport: transport() })
    await instance.start()
    expect(JSON.stringify(instance.status())).not.toContain('secret-token')
    instance.stop()
  })

  it('logout forgets the token and returns to unbound', async () => {
    const store = memoryStore({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'token' })
    const fake = transport()
    const instance = runtime({ store, transport: fake })
    await instance.start()

    await instance.logout()
    expect(instance.status().phase).toBe('unbound')
    expect(store.value).toBeUndefined()
    await instance.logout()
    instance.stop()
  })

  it('cancels a pending scan without leaving a stale error', async () => {
    const instance = runtime({ transport: transport({ polls: [{ status: 'wait' }] }) })
    await instance.beginLogin()
    instance.cancelLogin()
    expect(instance.status().phase).toBe('unbound')
    expect(instance.status().error).toBeUndefined()
    instance.stop()
  })

  it('issues a pairing code and revokes devices', async () => {
    const instance = runtime({})
    await instance.start()
    const { code } = instance.issueBindCode()
    expect(code).toMatch(/^\d{6}$/)
    expect(instance.revoke('missing')).toBe(false)
    instance.stop()
  })

  it('lets a stop during startup win', async () => {
    let release = (): void => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const proxy = {
      sessions: {
        list: vi.fn(async () => {
          await gate
          return { result: { ok: true, value: { items: [] } } }
        }),
        prompt: vi.fn(async () => ({ result: { ok: true, value: { accepted: true } } })),
        cancel: vi.fn(async () => ({ result: { ok: true, value: { accepted: true } } })),
      },
    }
    const slowCtx = {
      on: vi.fn(() => () => {}),
      get: (name: string) => (name === 'apiProxy' ? proxy : undefined),
    } as unknown as Context
    const instance = new RemoteRuntime({
      ctx: slowCtx,
      rootDir: rootDir(),
      capabilities,
      setPaused: vi.fn(async () => {}),
      credentials: memoryStore({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'token' }),
      createTransport: () => transport(),
      emptyPageDelayMs: 1,
    })

    const started = instance.start()
    instance.stop()
    release()
    const status = await started
    expect(status.phase).toBe('stopped')
    expect(instance.running).toBe(false)
  })

  it('fails when the host has no apiProxy', async () => {
    const broken = {
      on: vi.fn(() => () => {}),
      get: () => undefined,
    } as unknown as Context
    const instance = new RemoteRuntime({
      ctx: broken,
      rootDir: rootDir(),
      capabilities,
      setPaused: vi.fn(async () => {}),
      credentials: memoryStore(),
      createTransport: () => transport(),
      emptyPageDelayMs: 1,
    })
    const status = await instance.start()
    expect(status.phase).toBe('failed')
    expect(status.error).toContain('apiProxy')
    instance.stop()
  })
})
