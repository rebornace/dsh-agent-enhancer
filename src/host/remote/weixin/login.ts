import type { LoginPoll, LoginStatus, LoginTicket, WeixinCredentials } from './transport.ts'

export interface WeixinLoginTransport {
  beginLogin(localTokens?: readonly string[]): Promise<LoginTicket>
  pollLogin(ticket: string, verifyCode?: string): Promise<LoginPoll>
}

export type LoginPhase = 'idle' | 'waiting' | 'connected' | 'failed'

export interface LoginSnapshot {
  readonly phase: LoginPhase
  readonly status: LoginStatus
  readonly qrUrl?: string
  readonly error?: string
}

export interface WeixinLoginOptions {
  readonly transport: WeixinLoginTransport
  readonly pollIntervalMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly onChange?: (snapshot: LoginSnapshot) => void
}

const DEFAULT_POLL_INTERVAL_MS = 1_200
const DEFAULT_SLEEP = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type Waiter = (credentials: WeixinCredentials | undefined) => void

/**
 * One login attempt at a time.
 *
 * `begin` shows a QR and starts polling in the background; `wait` resolves with
 * credentials on confirmation, or `undefined` when the code expired, the
 * account needs verification, or the attempt was cancelled. A new `begin`
 * cancels the previous attempt, so two tickets can never race for the same
 * account.
 */
export class WeixinLogin {
  private snapshotValue: LoginSnapshot = { phase: 'idle', status: 'idle' }
  private ticket: string | undefined
  private credentialsValue: WeixinCredentials | undefined
  private stopped = true
  private settled = true
  private waiters: Waiter[] = []
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: WeixinLoginOptions) {
    this.sleep = options.sleep ?? DEFAULT_SLEEP
  }

  snapshot(): LoginSnapshot {
    return this.snapshotValue
  }

  credentials(): WeixinCredentials | undefined {
    return this.credentialsValue
  }

  async begin(): Promise<LoginTicket> {
    this.cancel()
    this.stopped = false
    this.settled = false
    this.credentialsValue = undefined
    const ticket = await this.options.transport.beginLogin()
    this.ticket = ticket.ticket
    this.update({ phase: 'waiting', status: 'wait', qrUrl: ticket.qrUrl })
    void this.run(ticket.ticket)
    return ticket
  }

  wait(): Promise<WeixinCredentials | undefined> {
    if (this.credentialsValue !== undefined) return Promise.resolve(this.credentialsValue)
    if (this.settled) return Promise.resolve(undefined)
    return new Promise(resolve => {
      this.waiters.push(resolve)
    })
  }

  cancel(): void {
    this.stopped = true
    this.ticket = undefined
    this.settle(undefined, { phase: 'idle', status: 'idle' })
  }

  private async run(ticket: string): Promise<void> {
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    while (!this.stopped && this.ticket === ticket) {
      let poll: LoginPoll
      try {
        poll = await this.options.transport.pollLogin(ticket)
      } catch (error) {
        if (this.stopped) return
        this.settle(undefined, {
          phase: 'failed',
          status: this.snapshotValue.status,
          ...(this.snapshotValue.qrUrl === undefined ? {} : { qrUrl: this.snapshotValue.qrUrl }),
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      if (this.stopped || this.ticket !== ticket) return

      const status = poll.status
      if (status === 'confirmed') {
        if (poll.credentials === undefined) {
          this.settle(undefined, {
            phase: 'failed',
            status,
            ...(this.snapshotValue.qrUrl === undefined ? {} : { qrUrl: this.snapshotValue.qrUrl }),
            error: '登录已确认，但服务没有返回凭据',
          })
          return
        }
        this.settle(poll.credentials, {
          phase: 'connected',
          status,
          ...(this.snapshotValue.qrUrl === undefined ? {} : { qrUrl: this.snapshotValue.qrUrl }),
        })
        return
      }
      if (status === 'expired' || status === 'scaned_but_redirect' || status === 'binded_redirect'
        || status === 'need_verifycode' || status === 'verify_code_blocked') {
        this.settle(undefined, {
          phase: 'failed',
          status,
          ...(this.snapshotValue.qrUrl === undefined ? {} : { qrUrl: this.snapshotValue.qrUrl }),
        })
        return
      }
      this.update({
        phase: 'waiting',
        status,
        ...(this.snapshotValue.qrUrl === undefined ? {} : { qrUrl: this.snapshotValue.qrUrl }),
      })
      await this.sleep(interval)
    }
  }

  private settle(credentials: WeixinCredentials | undefined, snapshot: LoginSnapshot): void {
    this.credentialsValue = credentials
    this.settled = true
    this.update(snapshot)
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter(credentials)
  }

  private update(snapshot: LoginSnapshot): void {
    this.snapshotValue = snapshot
    try {
      this.options.onChange?.(snapshot)
    } catch {
      // A listener must not break the login loop.
    }
  }
}
