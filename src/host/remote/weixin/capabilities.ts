import type { ChannelCapabilities } from '../types.ts'

/** WeChat private chats: no buttons, no message editing, protocol-provided voice text. */
export const WEIXIN_CAPABILITIES: ChannelCapabilities = {
  buttons: false,
  editMessage: false,
  threads: false,
  media: 'file',
  markdown: false,
  maxChars: 1800,
  privateOnly: true,
}
