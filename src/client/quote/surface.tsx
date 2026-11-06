import type { TranslateNS, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { quoteSelectedText } from './insert.ts'
import { QuoteFloatingButton } from './floating-button.tsx'

export type QuoteSurfaceProps = PropsRuntime<'conversation.chat.text-interaction'> & {
  readonly t: TranslateNS<'agent-enhancer'>
}

/**
 * Floating quote action for the official chat text-interaction surface.
 * Placement is owned by ChatView; this only renders the button chrome.
 */
export function QuoteSurface(props: QuoteSurfaceProps) {
  const label = props.t('quoteSelection')
  return (
    <QuoteFloatingButton
      label={label}
      onQuote={() => {
        const text = props.readText()
        if (text === null || text.trim() === '') {
          props.dismiss()
          return
        }
        const inserted = quoteSelectedText(text, props.sessionId)
        if (!inserted) return
        props.clearSelection()
        props.dismiss()
      }}
    />
  )
}
