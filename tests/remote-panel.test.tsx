// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteSettingsPanel } from '../src/client/remote/panel.tsx'
import type { RemoteChannelStatusWire, RemoteStatusWire } from '../src/host/rpc.ts'

afterEach(() => {
  cleanup()
})

const t = ((key: string) => key) as never

function channel(id: 'weixin' | 'telegram', overrides: Partial<RemoteChannelStatusWire> = {}): RemoteChannelStatusWire {
  return {
    id,
    phase: 'unbound',
    login: { phase: 'idle', status: 'idle' },
    devices: [],
    ...overrides,
  }
}

function status(overrides: Partial<RemoteStatusWire> = {}): RemoteStatusWire {
  return {
    phase: 'unbound',
    channels: [channel('weixin'), channel('telegram')],
    tasks: 0,
    ...overrides,
  }
}

function harness(initial: RemoteStatusWire) {
  let current = initial
  const remote = {
    agentEnhancer: {
      remoteStatus: vi.fn(async () => ({ ok: true, value: current })),
      remoteLoginBegin: vi.fn(async () => {
        current = status({
          channels: [
            channel('weixin', {
              login: { phase: 'waiting', status: 'wait', qrUrl: 'https://liteapp.weixin.qq.com/q/x?type=3' },
            }),
            channel('telegram'),
          ],
        })
        return { ok: true, value: { ok: true, ticket: 't1', qrUrl: 'https://liteapp.weixin.qq.com/q/x?type=3' } }
      }),
      remoteLoginCancel: vi.fn(async () => ({ ok: true, value: { ok: true } })),
      remoteBindCode: vi.fn(async (request: { channel: string }) => ({
        ok: true,
        value: { ok: true, code: request.channel === 'weixin' ? '246810' : '135790', expiresAt: 0 },
      })),
      remoteRevoke: vi.fn(async () => ({ ok: true, value: { ok: true, revoked: 1 } })),
      remoteLogout: vi.fn(async () => ({ ok: true, value: { ok: true } })),
      remoteTelegramConnect: vi.fn(async () => {
        current = status({
          phase: 'running',
          channels: [
            channel('weixin'),
            channel('telegram', { phase: 'running', login: { phase: 'connected', status: 'connected' }, handle: '@dsh_bot' }),
          ],
        })
        return { ok: true, value: { ok: true, username: 'dsh_bot' } }
      }),
    },
  }
  return { remote, get: () => remote }
}

describe('RemoteSettingsPanel', () => {
  it('renders a card per channel with its own actions', async () => {
    const { get } = harness(status())
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} />)
    expect(await screen.findByText('remoteChannelWeixin')).toBeTruthy()
    expect(screen.getByText('remoteChannelTelegram')).toBeTruthy()
    expect(screen.getByText('remoteLogin')).toBeTruthy()
    expect(screen.getByLabelText('remoteTelegramToken')).toBeTruthy()
    expect(screen.getByText('remoteTelegramConnect')).toBeTruthy()
  })

  it('shows the WeChat QR after a login begins', async () => {
    const { remote, get } = harness(status())
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} />)
    fireEvent.click(await screen.findByText('remoteLogin'))
    await waitFor(() => { expect(remote.agentEnhancer.remoteLoginBegin).toHaveBeenCalledOnce() })
    expect(await screen.findByRole('img', { name: 'remoteQrLabel' })).toBeTruthy()
    expect(screen.getByText('remoteLoginWaiting')).toBeTruthy()
  })

  it('connects Telegram with the pasted token', async () => {
    const { remote, get } = harness(status())
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} />)
    fireEvent.change(await screen.findByLabelText('remoteTelegramToken'), { target: { value: '123:abc' } })
    fireEvent.click(screen.getByText('remoteTelegramConnect'))
    await waitFor(() => {
      expect(remote.agentEnhancer.remoteTelegramConnect).toHaveBeenCalledWith({ token: '123:abc' })
    })
    expect(await screen.findByText('@dsh_bot')).toBeTruthy()
  })

  it('creates a pairing code for the channel it belongs to', async () => {
    const { remote, get } = harness(status({
      phase: 'running',
      channels: [
        channel('weixin', { phase: 'running', login: { phase: 'connected', status: 'connected' } }),
        channel('telegram'),
      ],
    }))
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} />)
    const buttons = await screen.findAllByText('remoteBindCode')
    fireEvent.click(buttons[0]!)
    expect(await screen.findByText('246810')).toBeTruthy()
    expect(remote.agentEnhancer.remoteBindCode).toHaveBeenCalledWith({ channel: 'weixin' })
  })

  it('revokes a device on its own channel', async () => {
    const { remote, get } = harness(status({
      phase: 'running',
      channels: [
        channel('weixin', {
          phase: 'running',
          login: { phase: 'connected', status: 'connected' },
          devices: [{ chatId: 'chat-1', boundAt: 0 }],
        }),
        channel('telegram'),
      ],
    }))
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} />)
    fireEvent.click(await screen.findByText('remoteRevoke'))
    await waitFor(() => {
      expect(remote.agentEnhancer.remoteRevoke).toHaveBeenCalledWith({ channel: 'weixin', chatId: 'chat-1' })
    })
  })
})
