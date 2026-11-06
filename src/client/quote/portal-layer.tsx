import { createPortal } from 'react-dom'
import styles from '../styles.module.css'
import { QuoteFloatingButton } from './floating-button.tsx'
import type { QuoteAnchor } from './position.ts'

export interface QuotePortalLayerProps {
  readonly label: string
  readonly anchor: QuoteAnchor
  readonly onQuote: () => void
}

/** Fixed-position quote chip portaled to document.body. */
export function QuotePortalLayer(props: QuotePortalLayerProps) {
  return createPortal(
    <div
      className={styles.quotePortal}
      style={{ left: props.anchor.left, top: props.anchor.top }}
      data-agent-enhancer-quote-portal=""
    >
      <QuoteFloatingButton label={props.label} onQuote={props.onQuote} />
    </div>,
    document.body,
  )
}
