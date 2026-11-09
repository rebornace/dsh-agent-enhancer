/** Official web chat origin — snapshot reads/writes only apply here. */
export const WEB_CHAT_OFFICIAL_ORIGIN = 'https://chat.deepseek.com'

export const WEB_CHAT_LOGIN_SNAPSHOT_VERSION = 1

export interface WebChatLoginSnapshot {
  readonly version: typeof WEB_CHAT_LOGIN_SNAPSHOT_VERSION
  readonly origin: string
  readonly localStorage: Readonly<Record<string, string>>
  readonly cookie: string
  readonly savedAt: string
}
