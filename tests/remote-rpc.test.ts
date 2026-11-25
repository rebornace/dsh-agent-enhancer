import { describe, expect, it } from 'vitest'
import {
  remoteBindCodeResultSchema,
  remoteLoginBeginResultSchema,
  remoteStatusSchema,
} from '../src/host/rpc.ts'
import { remoteInfo } from '../src/host/rpc.ts'
import {
  agentEnhancerRemoteBindCode,
  agentEnhancerRemoteLoginBegin,
  agentEnhancerRemoteRevoke,
  agentEnhancerRemoteStatus,
  clientRemoteInfo,
} from '../src/client/remote.ts'

const METHODS = [
  'remoteStatus',
  'remoteLoginBegin',
  'remoteLoginCancel',
  'remoteBindCode',
  'remoteRevoke',
  'remoteLogout',
] as const

describe('remote-control RPC surface', () => {
  it('registers every remote method on host and client', () => {
    const hostMethods = remoteInfo.descriptors.map(descriptor => descriptor.method)
    const clientMethods = clientRemoteInfo.descriptors.map(descriptor => descriptor.method)
    for (const method of METHODS) {
      expect(hostMethods).toContain(method)
      expect(clientMethods).toContain(method)
    }
  })

  it('accepts a status payload without any token field', () => {
    const parsed = remoteStatusSchema.parse({
      phase: 'running',
      login: { phase: 'connected', status: 'confirmed' },
      devices: [{ chatId: 'chat-1', boundAt: 100, channel: 'weixin' }],
      botId: 'bot-1',
    })
    expect(parsed.devices).toHaveLength(1)
    // Strict object: a token smuggled in must fail rather than pass through.
    expect(() => remoteStatusSchema.parse({
      phase: 'running',
      login: { phase: 'connected', status: 'confirmed' },
      devices: [],
      token: 'secret',
    })).toThrow()
  })

  it('keeps QR and bind results honest about failure', () => {
    expect(remoteLoginBeginResultSchema.parse({ ok: false, error: 'no credential service' }).ok).toBe(false)
    expect(remoteBindCodeResultSchema.parse({ ok: true, code: '123456', expiresAt: 10 }).code).toBe('123456')
    expect(() => remoteBindCodeResultSchema.parse({ ok: true, code: 'abcdef' })).toThrow()
  })

  it('returns an empty status when the host remote is missing', async () => {
    await expect(agentEnhancerRemoteStatus.invoke(null)).resolves.toEqual({
      phase: 'stopped',
      login: { phase: 'idle', status: 'idle' },
      devices: [],
      tasks: 0,
    })
  })

  it('explains an unavailable host instead of throwing', async () => {
    const begin = await agentEnhancerRemoteLoginBegin.invoke(undefined)
    expect(begin.ok).toBe(false)
    expect(begin.error).toBeTruthy()

    const bind = await agentEnhancerRemoteBindCode.invoke(undefined)
    expect(bind.ok).toBe(false)

    const revoke = await agentEnhancerRemoteRevoke.invoke(undefined, {})
    expect(revoke.ok).toBe(false)
    expect(revoke.revoked).toBe(0)
  })
})
