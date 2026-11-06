import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'
import { isDomQuoteSource } from './dom-source.ts'
import { quoteSelectedText } from './insert.ts'
import { placeQuoteChip } from './position.ts'
import type { QuoteAnchor } from './position.ts'
import { QuotePortalLayer } from './portal-layer.tsx'

export interface DomQuoteHostProps {
  readonly t: TranslateNS<'agent-enhancer'>
}

interface ActiveDomQuote {
  readonly text: string
  readonly anchor: QuoteAnchor
}

function readDomQuote(): ActiveDomQuote | null {
  const selection = document.getSelection()
  if (selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!isDomQuoteSource(range.commonAncestorContainer)) return null
  const text = selection.toString().replace(/\r\n?/gu, '\n').trim()
  if (text === '') return null
  const rects = [...range.getClientRects()]
  const rect = rects.find(candidate => candidate.width > 0 || candidate.height > 0)
    ?? range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { text, anchor: placeQuoteChip(rect) }
}

/**
 * Quote chip for official document preview (workspace files + extra-folder
 * opens). Chat transcript keeps the official text-interaction slot.
 */
export function DomQuoteHost(props: DomQuoteHostProps) {
  const [active, setActive] = useState<ActiveDomQuote | null>(null)
  const label = props.t('quoteSelection')

  useEffect(() => {
    let pointerSelecting = false
    let frame = 0

    const refresh = () => {
      setActive(readDomQuote())
    }

    const schedule = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        refresh()
      })
    }

    const onPointerDown = (event: PointerEvent) => {
      const path = event.composedPath()
      if (path.some(node => node instanceof Element && node.hasAttribute('data-agent-enhancer-quote-portal'))) {
        return
      }
      pointerSelecting = event.button === 0
      setActive(null)
    }

    const onPointerUp = () => {
      if (!pointerSelecting) return
      pointerSelecting = false
      schedule()
    }

    const onSelectionChange = () => {
      if (pointerSelecting) return
      schedule()
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActive(null)
        return
      }
      if (event.key === 'Shift' || event.shiftKey) schedule()
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
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
        document.getSelection()?.removeAllRanges()
        setActive(null)
      }}
    />
  )
}
