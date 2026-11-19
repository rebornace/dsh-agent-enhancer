/**
 * Placement math for the browser approval banner.
 *
 * The banner is a viewport-fixed card. The right sidebar is a layout column, so
 * a plain `right: 16px` parks the card on top of it. The card therefore reads
 * the open panel's width and steps left of it, keeping a minimum column for
 * itself so a fullscreen panel cannot push it off screen.
 */

export const BANNER_GAP = 16
export const MIN_BANNER_ROOM = 320

/** Distance from the viewport's right edge to the card's right edge. */
export function bannerRightInset(panelWidth: number, viewportWidth: number): number {
  const gap = BANNER_GAP
  if (!Number.isFinite(panelWidth) || panelWidth <= 0) return gap
  const capped = Math.max(gap, viewportWidth - MIN_BANNER_ROOM)
  return Math.min(panelWidth + gap, capped)
}
