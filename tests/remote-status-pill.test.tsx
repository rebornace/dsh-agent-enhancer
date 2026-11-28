// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteStatusWire } from '../src/host/rpc.ts'
import { RemoteStatusPill } from '../src/client/remote/status-pill.tsx'

afterEach(() => { cleanup() })

const t = ((key: string) => key) as never

function status(running: number): RemoteStatusWire {
  return {
    phase: running > 0 ? 'running' : 'unbound',
    channels: ['weixin', 'telegram', 'feishu'].map((id, index) => ({
      id: id as 'weixin' | 'telegram' | 'feishu',
      phase: index < running ? 'running' as const : 'unbound' as const,
      enabled: index < running,
      login: { phase: 'idle' as const, status: 'idle' },
      devices: index < running ? [{ chatId: `chat-${index}`, boundAt: 0 }] : [],
    })),
    tasks: 0,
  }
}

function makeRemote(running: number) {
  const setChannelEnabled = vi.fn(async (_request: { channel: string; enabled: boolean }) => ({
    ok: true,
    value: { ok: true },
  }))
  const remote = {
    agentEnhancer: {
      remoteStatus: vi.fn(async () => ({ ok: true, value: status(running) })),
      remoteSetChannelEnabled: setChannelEnabled,
    },
  }
  return { remote, setChannelEnabled }
}

function renderPill(running: number, enabled: boolean, persist: (ops: readonly unknown[]) => Promise<void>) {
  const { remote, setChannelEnabled } = makeRemote(running)
  render(
    <RemoteStatusPill
      t={t}
      getRemote={() => remote}
      isEnabled={() => enabled}
      persist={persist as never}
    />,
  )
  return { remote, setChannelEnabled }
}

describe('RemoteStatusPill', () => {
  it('does not render when the Settings feature switch is off', () => {
    renderPill(2, false, vi.fn(async () => {}))
    expect(screen.queryByText('remotePillOn')).toBeNull()
    expect(screen.queryByText('remotePillOff')).toBeNull()
    expect(document.querySelector('[class*="remotePillWrap"]')).toBeNull()
  })

  it('pauses all channels from the pill while the feature stays enabled', async () => {
    const persist = vi.fn(async (_ops: readonly unknown[]) => {})
    const { setChannelEnabled } = renderPill(2, true, persist)

    expect(await screen.findByText('remotePillOn')).toBeTruthy()
    fireEvent.click(screen.getByText('remotePillOn').closest('button')!)

    expect(persist).toHaveBeenCalledWith([
      { op: 'set', path: ['remoteWeixinEnabled'], value: false },
      { op: 'set', path: ['remoteTelegramEnabled'], value: false },
      { op: 'set', path: ['remoteFeishuEnabled'], value: false },
    ])
    await waitFor(() => { expect(setChannelEnabled).toHaveBeenCalledTimes(3) })
  })

  it('resumes all channels when the pill is paused', async () => {
    const persist = vi.fn(async (_ops: readonly unknown[]) => {})
    const { setChannelEnabled } = renderPill(0, true, persist)

    expect(await screen.findByText('remotePillOff')).toBeTruthy()
    fireEvent.click(screen.getByText('remotePillOff').closest('button')!)

    expect(persist).toHaveBeenCalledWith([
      { op: 'set', path: ['remoteWeixinEnabled'], value: true },
      { op: 'set', path: ['remoteTelegramEnabled'], value: true },
      { op: 'set', path: ['remoteFeishuEnabled'], value: true },
    ])
    await waitFor(() => { expect(setChannelEnabled).toHaveBeenCalledTimes(3) })
  })

  it('toggles a single channel from the caret menu', async () => {
    const persist = vi.fn(async (_ops: readonly unknown[]) => {})
    const { setChannelEnabled } = renderPill(2, true, persist)

    expect(await screen.findByText('remotePillOn')).toBeTruthy()
    fireEvent.click(screen.getByTitle('remotePillOpenMenu'))
    const wechat = await screen.findByText('remoteChannelWeixin')
    fireEvent.click(wechat.closest('button')!)

    expect(persist).toHaveBeenCalledWith([
      { op: 'set', path: ['remoteWeixinEnabled'], value: false },
    ])
    await waitFor(() => {
      expect(setChannelEnabled).toHaveBeenCalledWith({ channel: 'weixin', enabled: false })
    })
  })
})
