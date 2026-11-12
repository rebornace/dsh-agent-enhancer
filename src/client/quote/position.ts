export interface QuoteAnchor {
  readonly left: number
  readonly top: number
}

const GAP = 8
const BUTTON_GUESS_WIDTH = 56
const BUTTON_GUESS_HEIGHT = 28

interface QuoteRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/**
 * Match Desktop Menu portal math (dsh-client-ui-primitives Menu):
 * WebKit reports client coords from the visual origin; `position: fixed` uses
 * the layout origin, so add visualViewport offsets once when placing the chip.
 */
function layoutOriginOffset(): { readonly x: number; readonly y: number } {
  if (typeof window === 'undefined' || typeof window.CSS === 'undefined') {
    return { x: 0, y: 0 }
  }
  if (!window.CSS.supports('-webkit-backdrop-filter', 'none')) return { x: 0, y: 0 }
  const viewport = window.visualViewport
  return { x: viewport?.offsetLeft ?? 0, y: viewport?.offsetTop ?? 0 }
}

function layoutViewportSize(): { readonly width: number; readonly height: number } {
  if (typeof window === 'undefined') return { width: 0, height: 0 }
  const viewport = window.visualViewport
  // Prefer layout-sized bounds so fixed clamping matches CSS fixed coordinates.
  const width = Math.max(window.innerWidth, Math.round(viewport?.width ?? 0) + Math.round(viewport?.offsetLeft ?? 0))
  const height = Math.max(window.innerHeight, Math.round(viewport?.height ?? 0) + Math.round(viewport?.offsetTop ?? 0))
  return { width, height }
}

function toLayoutRect(anchor: QuoteRect): QuoteRect {
  const offset = layoutOriginOffset()
  return {
    left: anchor.left + offset.x,
    top: anchor.top + offset.y,
    right: anchor.right + offset.x,
    bottom: anchor.bottom + offset.y,
  }
}

/** Place a floating quote chip near an anchor rect, clamped to the viewport. */
export function placeQuoteChip(anchor: DOMRect | QuoteRect): QuoteAnchor {
  const layout = toLayoutRect(anchor)
  const { width: viewW, height: viewH } = layoutViewportSize()
  const preferredAbove = layout.top - GAP - BUTTON_GUESS_HEIGHT
  const top = preferredAbove >= 4
    ? preferredAbove
    : Math.min(layout.bottom + GAP, Math.max(4, viewH - BUTTON_GUESS_HEIGHT - 4))
  const centerX = (Math.max(layout.left, 0) + Math.min(layout.right, viewW)) / 2
  const left = Math.max(4, Math.min(centerX - BUTTON_GUESS_WIDTH / 2, Math.max(4, viewW - BUTTON_GUESS_WIDTH - 4)))
  return { left, top }
}
