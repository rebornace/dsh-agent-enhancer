export interface QuoteAnchor {
  readonly left: number
  readonly top: number
}

const GAP = 8
const BUTTON_GUESS_WIDTH = 56
const BUTTON_GUESS_HEIGHT = 28

/** Place a floating quote chip near an anchor rect, clamped to the viewport. */
export function placeQuoteChip(anchor: DOMRect | { left: number; top: number; right: number; bottom: number }): QuoteAnchor {
  const viewW = window.innerWidth
  const viewH = window.innerHeight
  const preferredAbove = anchor.top - GAP - BUTTON_GUESS_HEIGHT
  const top = preferredAbove >= 4
    ? preferredAbove
    : Math.min(anchor.bottom + GAP, viewH - BUTTON_GUESS_HEIGHT - 4)
  const centerX = (Math.max(anchor.left, 0) + Math.min(anchor.right, viewW)) / 2
  const left = Math.max(4, Math.min(centerX - BUTTON_GUESS_WIDTH / 2, viewW - BUTTON_GUESS_WIDTH - 4))
  return { left, top }
}
