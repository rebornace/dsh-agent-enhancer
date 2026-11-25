import { describe, expect, it, vi } from 'vitest'
import { WeixinLogin } from '../src/host/remote/weixin/login.ts'
import type { LoginPoll } from '../src/host/remote/weixin/transport.ts'

const ticket = { ticket: 'ticket-1', qrUrl: 'https://liteapp.weixin.qq.com/q/x' }

function transport(polls: LoginPoll[]) {
  return {
    beginLogin: vi.fn(async () => ticket),
    pollLogin: vi.fn(async () => polls.shift() ?? { status: 'wait' }),
  }
}

describe('WeixinLogin', () => {
  it('shows the QR, polls, and returns credentials on confirmation', async () => {
    const polls: LoginPoll[] = [
      { status: 'wait' },
      { status: 'confirmed', credentials: { baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'token-1' } },
    ]
    const login = new WeixinLogin({ transport: transport(polls), sleep: async () => {} })

    const started = await login.begin()
    expect(started).toEqual(ticket)
    expect(login.snapshot()).toMatchObject({ phase: 'waiting', status: 'wait', qrUrl: ticket.qrUrl })

    const credentials = await login.wait()
    expect(credentials?.token).toBe('token-1')
    expect(login.snapshot().phase).toBe('connected')
  })

  it('resolves undefined when the code expires', async () => {
    const polls: LoginPoll[] = [{ status: 'expired' }]
    const login = new WeixinLogin({ transport: transport(polls), sleep: async () => {} })
    await login.begin()
    await expect(login.wait()).resolves.toBeUndefined()
    expect(login.snapshot()).toMatchObject({ phase: 'failed', status: 'expired' })
  })

  it('resolves undefined when the account needs verification', async () => {
    const polls: LoginPoll[] = [{ status: 'need_verifycode' }]
    const login = new WeixinLogin({ transport: transport(polls), sleep: async () => {} })
    await login.begin()
    await expect(login.wait()).resolves.toBeUndefined()
    expect(login.snapshot().status).toBe('need_verifycode')
  })

  it('cancels the current attempt', async () => {
    const polls: LoginPoll[] = [{ status: 'wait' }, { status: 'wait' }]
    const fake = transport(polls)
    const login = new WeixinLogin({ transport: fake, sleep: async () => {} })
    await login.begin()
    login.cancel()

    await expect(login.wait()).resolves.toBeUndefined()
    expect(login.snapshot().phase).toBe('idle')
    const callsAfterCancel = fake.pollLogin.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(fake.pollLogin.mock.calls.length).toBe(callsAfterCancel)
  })

  it('reports a poll failure instead of hanging', async () => {
    const fake = {
      beginLogin: vi.fn(async () => ticket),
      pollLogin: vi.fn(async () => {
        throw new Error('network down')
      }),
    }
    const login = new WeixinLogin({ transport: fake, sleep: async () => {} })
    await login.begin()
    await expect(login.wait()).resolves.toBeUndefined()
    expect(login.snapshot()).toMatchObject({ phase: 'failed', error: 'network down' })
  })

  it('resets state when a new attempt begins', async () => {
    const fake = {
      beginLogin: vi.fn(async () => ticket),
      pollLogin: vi.fn(async () => ({ status: 'wait' as const })),
    }
    const login = new WeixinLogin({ transport: fake, sleep: async () => {} })
    await login.begin()
    login.cancel()
    await login.begin()
    expect(fake.beginLogin).toHaveBeenCalledTimes(2)
    expect(login.snapshot().phase).toBe('waiting')
    login.cancel()
  })
})
