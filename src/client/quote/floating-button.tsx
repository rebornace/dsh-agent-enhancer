import styles from '../styles.module.css'

export interface QuoteFloatingButtonProps {
  readonly label: string
  readonly onQuote: () => void
  readonly className?: string
}

/**
 * Plain button — avoid primitives Button ghost hover, which can clear the
 * floating fill and let underlying text paint through the chip.
 */
export function QuoteFloatingButton(props: QuoteFloatingButtonProps) {
  return (
    <button
      type="button"
      className={props.className === undefined
        ? styles.quoteSelectionButton
        : `${styles.quoteSelectionButton} ${props.className}`}
      aria-label={props.label}
      onMouseDown={event => {
        // Keep the source selection until onQuote reads it.
        event.preventDefault()
      }}
      onClick={props.onQuote}
    >
      {props.label}
    </button>
  )
}
