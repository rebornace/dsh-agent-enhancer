import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'
import { quoteSelectedText } from './insert.ts'
import { placeQuoteChip } from './position.ts'
import type { QuoteAnchor } from './position.ts'
import { QuotePortalLayer } from './portal-layer.tsx'
import { readTerminalSelection } from './terminal-probe.ts'

export interface TerminalQuoteHostProps {
  readonly t: TranslateNS<'agent-enhancer'>
}

interface ActiveTerminalQuote {
  readonly text: string
  readonly anchor: QuoteAnchor
}

/**
 * Quote chip for sidebar xterm panes. Selection text comes from the Terminal
 * instance recovered via React fiber (no official plugin selection API).
 */
export function TerminalQuoteHost(props: TerminalQuoteHostProps) {
  const [active, setActive] = useState<ActiveTerminalQuote | null>(null)
  const label = props.t('quoteSelection')

  useEffect(() => {
    const onPointerUp = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target === null) return
      if (target.closest('[data-agent-enhancer-quote-portal]') !== null) return
      const pane = target.closest('[data-sidebar-terminal]')
      if (pane === null) {
        setActive(null)
        return
      }
      const text = readTerminalSelection(pane)
      if (text === null) {
        setActive(null)
        return
      }
      const xterm = pane.querySelector('.xterm') ?? pane
      const rect = xterm.getBoundingClientRect()
      // Prefer the pointer as anchor — xterm selection rects are not DOM ranges.
      const anchor = placeQuoteChip({
        left: event.clientX,
        right: event.clientX + 1,
        top: event.clientY,
        bottom: event.clientY + 1,
      })
      // Keep chip inside the terminal pane horizontally when possible.
      const clamped: QuoteAnchor = {
        left: Math.max(rect.left + 4, Math.min(anchor.left, rect.right - 60)),
        top: Math.max(rect.top + 4, Math.min(anchor.top, rect.bottom - 32)),
      }
      setActive({ text, anchor: clamped })
    }

    const onPointerDown = (event: PointerEvent) => {
      const path = event.composedPath()
      if (path.some(node => node instanceof Element && node.hasAttribute('data-agent-enhancer-quote-portal'))) {
        return
      }
      setActive(null)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActive(null)
    }

    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  if (active === null) return null
  return (
    <QuotePortalLayer
      label={label}
      anchor={active.anchor}
      onQuote={() => {
        const inserted = quoteSelectedText(active.text)
        if (!inserted) return
        setActive(null)
      }}
    />
  )
}
