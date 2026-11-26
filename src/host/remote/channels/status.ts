import type { RemoteChannel } from '../bindings.ts'

export type ChannelPhase = 'off' | 'unbound' | 'running' | 'failed'

export interface ChannelLoginState {
  readonly phase: 'idle' | 'waiting' | 'connected' | 'failed'
  /** Raw platform status token; the UI only uses `phase` and `error`. */
  readonly status: string
  readonly qrUrl?: string
  readonly error?: string
}

export interface ChannelDevice {
  readonly chatId: string
  readonly boundAt: number
}

export interface ChannelStatus {
  readonly id: RemoteChannel
  readonly phase: ChannelPhase
  readonly login: ChannelLoginState
  readonly devices: readonly ChannelDevice[]
  /** Bot identity for humans: WeChat bot id, Telegram @username. */
  readonly handle?: string
  readonly error?: string
}

export interface HubStatus {
  /** running if any channel is live; failed only when every channel failed. */
  readonly phase: 'stopped' | 'unbound' | 'running' | 'failed'
  readonly channels: readonly ChannelStatus[]
  readonly tasks: number
  /** Hub-level failure (session list unavailable), not a channel error. */
  readonly error?: string
}
