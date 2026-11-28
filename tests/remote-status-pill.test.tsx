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
      login: { phase: 'idle' as const, status: 'idle' },
      devices: index < running ? [{ chatId: `chat-${index}`, boundAt: 0 }] : [],
    })),
    tasks: 0,
  }
}

describe('RemoteStatusPill', () => {
  it('starts remote control in one click when it is off', async () => {
    const persist = vi.fn(async (_ops: readonly unknown[]) => {})
    const remote = { agentEnhancer: { remoteStatus: vi.fn(async () => ({ ok: true, value: status(3) })) } }
    render(
      <RemoteStatusPill
        t={t}
        getRemote={() => remote}
        isEnabled={() => false}
        persist={persist as never}
      />,
    )

    expect(await screen.findByText('remotePillOff')).toBeTruthy()
    fireEvent.click(screen.getByText('remotePillOff').closest('button')!)
    expect(persist).toHaveBeenCalledWith([
      { op: 'set', path: ['remoteControlEnabled'], value: true },
    ])
  })

  it('shows connected channels and stops pushes in one click when on', async () => {
    const persist = vi.fn(async (_ops: readonly unknown[]) => {})
    const remote = { agentEnhancer: { remoteStatus: vi.fn(async () => ({ ok: true, value: status(2) })) } }
    render(
      <RemoteStatusPill
        t={t}
        getRemote={() => remote}
        isEnabled={() => true}
        persist={persist as never}
      />,
    )

    expect(await screen.findByText('remotePillOn')).toBeTruthy()
    await waitFor(() => { expect(screen.getByText('2')).toBeTruthy() })
    const button = screen.getByText('remotePillOn').closest('button')!
    expect(button.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(button)
    expect(persist).toHaveBeenCalledWith([
      { op: 'set', path: ['remoteControlEnabled'], value: false },
    ])
  })
})
