import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ChatConversationViewNode, ChatSnapshot, TurnTailChatData, UserMessageNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PromptEntry } from '../prompt/types.ts'

export interface CompletedTurn {
  readonly turn: number
  readonly prompt: string
  readonly response: string
}

function textOf(node: UserMessageNode): string {
  return node.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function turnOf(node: ChatConversationViewNode): number | undefined {
  return node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn.turn
    : undefined
}

export function sentPrompts(chat: ChatSnapshot | undefined): readonly PromptEntry[] {
  if (chat === undefined) return []
  return chat.order.flatMap((key) => {
    const node = chat.nodes.get(key)
    if (node?.kind !== 'user') return []
    const text = textOf(node.data as UserMessageNode)
    return text.trim() === '' ? [] : [{ seq: (node.data as UserMessageNode).seq, text }]
  })
}

export function latestCompletedTurn(
  chat: ChatSnapshot | undefined,
  session: SessionSnapshot,
): CompletedTurn | null {
  if (chat === undefined || session.running) return null
  let tailNode: ChatConversationViewNode | undefined
  for (let index = chat.order.length - 1; index >= 0; index -= 1) {
    const candidate = chat.nodes.get(chat.order[index]!)
    if (candidate?.kind === 'turn-tail') {
      tailNode = candidate
      break
    }
  }
  if (tailNode === undefined) return null
  const tail = tailNode.data as TurnTailChatData
  const closing = tail.closing
  if (closing?.status !== 'settled') return null
  const prompt = chat.order.flatMap((key) => {
    const node = chat.nodes.get(key)
    if (node?.kind !== 'user' || turnOf(node) !== tail.turn) return []
    return [textOf(node.data as UserMessageNode)]
  }).join('')
  const response = closing.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('')
  return { turn: tail.turn, prompt, response }
}
