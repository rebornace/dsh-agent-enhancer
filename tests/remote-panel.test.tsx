// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteControlPanel } from '../src/client/remote/panel.tsx'
import type { RemoteStatusWire } from '../src/host/rpc.ts'

afterEach(() => {
  cleanup()
})

const t = ((key: string) => key) as never

function status(overrides: Partial<RemoteStatusWire> = {}): RemoteStatusWire {
  return {
    phase: 'unbound',
    login: { phase: 'idle', status: 'idle' },
    devices: [],
    ...overrides,
  }
}

function harness(initial: RemoteStatusWire) {
  let current = initial
  const remote = {
    agentEnhancer: {
      remoteStatus: vi.fn(async () => ({ ok: true, value: current })),
      remoteLoginBegin: vi.fn(async () => {
        current = status({ login: { phase: 'waiting', status: 'wait', qrUrl: 'https://liteapp.weixin.qq.com/q/x?type=3' } })
        return { ok: true, value: { ok: true, ticket: 't1', qrUrl: 'https://liteapp.weixin.qq.com/q/x?type=3' } }
      }),
      remoteLoginCancel: vi.fn(async () => ({ ok: true, value: { ok: true } })),
      remoteBindCode: vi.fn(async () => ({ ok: true, value: { ok: true, code: '246810', expiresAt: 0 } })),
      remoteRevoke: vi.fn(async () => ({ ok: true, value: { ok: true, revoked: 1 } })),
      remoteLogout: vi.fn(async () => ({ ok: true, value: { ok: true } })),
    },
  }
  return { remote, get: () => remote }
}

describe('RemoteControlPanel', () => {
  it('renders the phase and paired devices', async () => {
    const device = { chatId: 'wxid_abcdefghijklmn', boundAt: Date.parse('2026-11-25'), channel: 'weixin' }
    const { get } = harness(status({ phase: 'running', devices: [device] }))
    render(<RemoteControlPanel t={t} getRemote={get} busy={false} />)

    expect(await screen.findByText('remoteStatus_running')).toBeTruthy()
    expect(screen.getByText('wxid_a…klmn')).toBeTruthy()
    expect(screen.getByText('remoteRevoke')).toBeTruthy()
  })

  it('shows the QR after a login begins', async () => {
    const { remote, get } = harness(status())
    render(<RemoteControlPanel t={t} getRemote={get} busy={false} />)

    fireEvent.click(await screen.findByText('remoteLogin'))
    await waitFor(() => { expect(remote.agentEnhancer.remoteLoginBegin).toHaveBeenCalledOnce() })
    expect(await screen.findByRole('img', { name: 'remoteQrLabel' })).toBeTruthy()
    expect(screen.getByText('remoteLoginWaiting')).toBeTruthy()
  })

  it('reveals a pairing code and can revoke a device', async () => {
    const device = { chatId: 'chat-1', boundAt: 0, channel: 'weixin' }
    const { remote, get } = harness(status({ phase: 'running', devices: [device] }))
    render(<RemoteControlPanel t={t} getRemote={get} busy={false} />)

    fireEvent.click(await screen.findByText('remoteBindCode'))
    expect(await screen.findByText('246810')).toBeTruthy()

    fireEvent.click(screen.getByText('remoteRevoke'))
    await waitFor(() => {
      expect(remote.agentEnhancer.remoteRevoke).toHaveBeenCalledWith({ chatId: 'chat-1' })
    })
  })

  it('surfaces a failed login instead of hiding it', async () => {
    const { get } = harness(status({
      phase: 'unbound',
      login: { phase: 'failed', status: 'expired' },
    }))
    render(<RemoteControlPanel t={t} getRemote={get} busy={false} />)
    expect(await screen.findByText('remoteLoginExpired')).toBeTruthy()
  })
})
