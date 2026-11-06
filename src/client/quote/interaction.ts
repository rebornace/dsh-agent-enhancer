import type { TextInteractionDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Must match the keyed `conversation.chat.text-interaction` slot entry. */
export const QUOTE_INTERACTION_ID = 'agent-enhancer-quote'

/** Admit transcript selection / context-menu gestures that carry nonblank text. */
export const quoteInteraction: TextInteractionDefinition = {
  id: QUOTE_INTERACTION_ID,
  onInteraction(request) {
    if (!request.hasSelection) return
    const text = request.readText()
    if (text === null || text.trim() === '') return
    if (request.trigger === 'contextmenu') request.preventDefault()
    request.open()
  },
}
