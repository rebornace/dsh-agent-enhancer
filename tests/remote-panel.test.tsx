// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteSettingsPanel } from '../src/client/remote/panel.tsx'
import type { RemoteChannelStatusWire, RemoteStatusWire } from '../src/host/rpc.ts'

afterEach(() => {
  cleanup()
})

const t = ((key: string) => key) as never

function channel(id: 'weixin' | 'telegram' | 'feishu', overrides: Partial<RemoteChannelStatusWire> = {}): RemoteChannelStatusWire {
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
    channels: [channel('weixin'), channel('telegram'), channel('feishu')],
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
            channel('feishu'),
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
            channel('feishu'),
          ],
        })
        return { ok: true, value: { ok: true, username: 'dsh_bot' } }
      }),
      remoteFeishuConnect: vi.fn(async () => {
        current = status({
          phase: 'running',
          channels: [
            channel('weixin'),
            channel('telegram'),
            channel('feishu', { phase: 'running', login: { phase: 'connected', status: 'connected' }, handle: 'DSH 助手' }),
          ],
        })
        return { ok: true, value: { ok: true, name: 'DSH 助手' } }
      }),
    },
  }
  return { remote, get: () => remote }
}

describe('RemoteSettingsPanel', () => {
  it('asks the user to enable the feature first', async () => {
    const { get } = harness(status())
    const onOpenFeatures = vi.fn()
    render(
      <RemoteSettingsPanel
        t={t}
        getRemote={get}
        busy={false}
        enabled={false}
        onOpenFeatures={onOpenFeatures}
      />,
    )
    expect(await screen.findByText('remoteDisabledHint')).toBeTruthy()
    expect(screen.queryByText('remoteChannelWeixin')).toBeNull()
    fireEvent.click(screen.getByText('remoteOpenFeatures'))
    expect(onOpenFeatures).toHaveBeenCalledOnce()
  })

  it('renders a card per channel with its own actions', async () => {
    const { get } = harness(status())
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} enabled onOpenFeatures={() => {}} />)
    expect(await screen.findByText('remoteChannelWeixin')).toBeTruthy()
    expect(screen.getByText('remoteChannelTelegram')).toBeTruthy()
    expect(screen.getByText('remoteChannelFeishu')).toBeTruthy()
    expect(screen.getByText('remoteLogin')).toBeTruthy()
    expect(screen.getByLabelText('remoteTelegramToken')).toBeTruthy()
    expect(screen.getByText('remoteTelegramConnect')).toBeTruthy()
    expect(screen.getByLabelText('remoteFeishuAppId')).toBeTruthy()
    expect(screen.getByLabelText('remoteFeishuAppSecret')).toBeTruthy()
    expect(screen.getByText('remoteFeishuConnect')).toBeTruthy()
  })

  it('connects Feishu with the app credentials and shows the bot name', async () => {
    const { remote, get } = harness(status())
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} enabled onOpenFeatures={() => {}} />)
    fireEvent.change(await screen.findByLabelText('remoteFeishuAppId'), { target: { value: 'cli_abc' } })
    fireEvent.change(screen.getByLabelText('remoteFeishuAppSecret'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByText('remoteFeishuConnect'))
    await waitFor(() => {
      expect(remote.agentEnhancer.remoteFeishuConnect).toHaveBeenCalledWith({
        appId: 'cli_abc',
        appSecret: 'secret',
      })
    })
    expect(await screen.findByText('DSH 助手')).toBeTruthy()
  })

  it('links each Feishu guide step to the app once the App ID is entered', async () => {
    const { get } = harness(status())
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} enabled onOpenFeatures={() => {}} />)
    // The template path is recommended first; the manual steps stay folded.
    expect(await screen.findByText('remoteFeishuTemplateTitle')).toBeTruthy()
    expect(screen.queryByText('remoteFeishuGuideNeedId')).toBeNull()
    fireEvent.click(screen.getByText('remoteFeishuGuideShow'))
    expect(screen.getByText('remoteFeishuGuideNeedId')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('remoteFeishuAppId'), { target: { value: 'cli_abc123' } })
    await waitFor(() => {
      expect(document.querySelector('a[href="https://open.feishu.cn/app/cli_abc123/auth"]')).toBeTruthy()
    })
    expect(document.querySelector('a[href="https://open.feishu.cn/app/cli_abc123/event?tab=event"]')).toBeTruthy()
    expect(document.querySelector('a[href="https://open.feishu.cn/app/cli_abc123/event?tab=callback"]')).toBeTruthy()
    expect(document.querySelector('a[href="https://open.feishu.cn/app/cli_abc123"]')).toBeTruthy()
    expect(screen.queryByText('remoteFeishuGuideNeedId')).toBeNull()
  })

  it('copies the Feishu scope list from the guide', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    const { get } = harness(status())
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} enabled onOpenFeatures={() => {}} />)
    fireEvent.click(await screen.findByText('remoteFeishuGuideShow'))
    fireEvent.click(screen.getByText('remoteFeishuGuideCopyScopes'))
    await waitFor(() => { expect(writeText).toHaveBeenCalledOnce() })
    const payload = String(writeText.mock.calls[0]?.[0])
    expect(payload).toContain('im:message.p2p_msg:readonly')
    expect(payload).toContain('im:message:send_as_bot')
    expect(payload).toContain('im:message.readonly')
    expect(await screen.findByText('remoteFeishuGuideCopied')).toBeTruthy()
  })

  it('shows the scope list when the clipboard is blocked', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { throw new Error('blocked') }) },
      configurable: true,
    })
    const { get } = harness(status())
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} enabled onOpenFeatures={() => {}} />)
    fireEvent.click(await screen.findByText('remoteFeishuGuideShow'))
    fireEvent.click(screen.getByText('remoteFeishuGuideCopyScopes'))
    expect(await screen.findByText('remoteFeishuGuideCopyFailed')).toBeTruthy()
    expect(screen.getByText(/"im:message\.p2p_msg:readonly"/)).toBeTruthy()
  })

  it('shows the WeChat QR after a login begins', async () => {
    const { remote, get } = harness(status())
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} enabled onOpenFeatures={() => {}} />)
    fireEvent.click(await screen.findByText('remoteLogin'))
    await waitFor(() => { expect(remote.agentEnhancer.remoteLoginBegin).toHaveBeenCalledOnce() })
    expect(await screen.findByRole('img', { name: 'remoteQrLabel' })).toBeTruthy()
    expect(screen.getByText('remoteLoginWaiting')).toBeTruthy()
  })

  it('opens a BotFather QR for the phone instead of a browser link', async () => {
    const { get } = harness(status())
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} enabled onOpenFeatures={() => {}} />)
    fireEvent.click(await screen.findByText('remoteTelegramOpenBotFather'))
    expect(await screen.findByRole('img', { name: 'remoteTelegramQrLabel' })).toBeTruthy()
    expect(screen.getByText('remoteTelegramNameHint')).toBeTruthy()
    expect(document.querySelector('a[href="https://t.me/BotFather"]')).toBeNull()
    fireEvent.click(screen.getByText('remoteTelegramHideBotFather'))
    expect(screen.queryByRole('img', { name: 'remoteTelegramQrLabel' })).toBeNull()
  })

  it('connects Telegram with the pasted token', async () => {
    const { remote, get } = harness(status())
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} enabled onOpenFeatures={() => {}} />)
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
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} enabled onOpenFeatures={() => {}} />)
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
    render(<RemoteSettingsPanel t={t} getRemote={get} busy={false} enabled onOpenFeatures={() => {}} />)
    fireEvent.click(await screen.findByText('remoteRevoke'))
    await waitFor(() => {
      expect(remote.agentEnhancer.remoteRevoke).toHaveBeenCalledWith({ channel: 'weixin', chatId: 'chat-1' })
    })
  })
})
