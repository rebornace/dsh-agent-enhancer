import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createWeixinCredentialStore } from '../src/host/remote/weixin/credentials.ts'

function ctxWith(provider: unknown): Context {
  return {
    get: (name: string) => (name === 'credentials' ? provider : undefined),
  } as unknown as Context
}

function memoryProvider() {
  const values = new Map<string, string>()
  return {
    values,
    resolve: vi.fn(async (ref: string) => {
      const value = values.get(ref)
      return value === undefined ? undefined : { value }
    }),
    set: vi.fn(async (ref: string, value: string) => {
      values.set(ref, value)
    }),
    unset: vi.fn(async (ref: string) => {
      values.delete(ref)
    }),
  }
}

describe('createWeixinCredentialStore', () => {
  it('stores and loads the whole login tuple as one secret', async () => {
    const provider = memoryProvider()
    const store = createWeixinCredentialStore(ctxWith(provider))
    const credentials = {
      baseUrl: 'https://ilinkai.weixin.qq.com/',
      token: 'bot-token',
      botId: 'bot-1',
      userId: 'user-1',
    }

    await store.save(credentials)
    await expect(store.load()).resolves.toEqual(credentials)
    expect(provider.set).toHaveBeenCalledOnce()
    expect(JSON.stringify([...provider.values.values()])).toContain('bot-token')

    await store.clear()
    await expect(store.load()).resolves.toBeUndefined()
  })

  it('ignores a corrupt stored payload', async () => {
    const provider = memoryProvider()
    provider.values.set('DSH_AGENT_ENHANCER_WEIXIN', 'not json')
    const store = createWeixinCredentialStore(ctxWith(provider))
    await expect(store.load()).resolves.toBeUndefined()
  })

  it('refuses to write when the host has no credential service', async () => {
    const store = createWeixinCredentialStore(ctxWith(undefined))
    await expect(store.load()).resolves.toBeUndefined()
    await expect(store.save({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 't' }))
      .rejects.toThrow(/凭据服务/)
  })
})
