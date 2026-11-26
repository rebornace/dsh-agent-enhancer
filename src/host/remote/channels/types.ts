/**
 * Channel-neutral message shapes.
 *
 * Every IM platform is reduced to the same three ideas: a long poll returns a
 * cursor plus messages, a message has a chat id and typed items, and a reply is
 * text. Everything platform-specific stays inside that platform's transport.
 */

export type InboundItem =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'voice'; readonly text?: string }
  | { readonly kind: 'image' }
  | { readonly kind: 'file' }
  | { readonly kind: 'other' }

export interface InboundMessage {
  readonly seq: number
  readonly messageId: number
  /** Chat/thread identity the reply goes to. */
  readonly fromUserId: string
  readonly toUserId: string
  readonly createdAt: number
  readonly items: readonly InboundItem[]
  /** WeChat replies need the latest one; other platforms ignore it. */
  readonly contextToken?: string
  /** Telegram callback query id; must be acknowledged to stop the spinner. */
  readonly callbackQueryId?: string
}

export interface UpdatesPage {
  readonly cursor: string
  readonly messages: readonly InboundMessage[]
}

export interface OutboundOptions {
  readonly contextToken?: string
  /** Inline action buttons; platforms without buttons ignore them. */
  readonly buttons?: readonly { readonly label: string; readonly command: string }[]
}

export interface ChannelTransport {
  getUpdates(cursor: string): Promise<UpdatesPage>
  sendText(chatId: string, text: string, options?: OutboundOptions): Promise<unknown>
  /** Stop a Telegram callback spinner; no-op elsewhere. */
  acknowledge?(callbackQueryId: string): Promise<void>
}

/** A transport failure that will not heal by retrying (bad or revoked token). */
export class ChannelAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ChannelAuthError'
  }
}
