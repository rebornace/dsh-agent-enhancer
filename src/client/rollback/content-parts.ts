import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { UserContentAttachment } from '@deepseek-ai/dsh-client-ui-chat/client'

export function contentParts(content: readonly ContentBlock[]): {
  readonly text: string
  readonly attachments: readonly UserContentAttachment[]
  readonly rest: readonly unknown[]
} {
  const texts: string[] = []
  const attachments: UserContentAttachment[] = []
  const rest: unknown[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'image' && 'attachment' in block && block.attachment !== undefined) {
      attachments.push({ type: 'image', image: { attachment: block.attachment } })
    } else if (block.type === 'file' && 'attachment' in block && block.attachment !== undefined) {
      attachments.push({ type: 'file', file: block.attachment })
    } else rest.push(block)
  }
  return { text: texts.join(''), attachments, rest }
}
