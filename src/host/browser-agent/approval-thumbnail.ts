/**
 * Preview of the element an approval card is asking about.
 *
 * The card shows a small crop of the target control, so "allow this click" is a
 * decision about something you can see. Cropping is pure geometry (tested); the
 * driver only takes the screenshot with the resulting clip.
 */

export const THUMBNAIL_PADDING = 12
export const THUMBNAIL_MAX_WIDTH = 520
export const THUMBNAIL_MAX_HEIGHT = 260
/** Past this the base64 payload is not worth the RPC (a whole-page container). */
export const MAX_THUMBNAIL_BASE64 = 400_000

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface Clip {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Crop around the element: padding on all sides, clamped to the viewport and to
 * a readable maximum. Returns null when the element is scrolled out of view or
 * too small to be worth a picture.
 */
export function clampThumbnailClip(box: Box, viewport: { readonly width: number; readonly height: number }): Clip | null {
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) return null
  if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) return null
  if (box.width <= 0 || box.height <= 0) return null

  const left = Math.max(0, box.x - THUMBNAIL_PADDING)
  const top = Math.max(0, box.y - THUMBNAIL_PADDING)
  const right = Math.min(viewport.width, box.x + box.width + THUMBNAIL_PADDING)
  const bottom = Math.min(viewport.height, box.y + box.height + THUMBNAIL_PADDING)
  if (right - left < 8 || bottom - top < 8) return null

  const width = Math.min(right - left, THUMBNAIL_MAX_WIDTH)
  const height = Math.min(bottom - top, THUMBNAIL_MAX_HEIGHT)
  return { x: Math.round(left), y: Math.round(top), width: Math.round(width), height: Math.round(height) }
}

/** Keep a screenshot only when it is small enough to ship inside one RPC reply. */
export function keepThumbnail(base64: string): boolean {
  return base64.length > 0 && base64.length <= MAX_THUMBNAIL_BASE64
}
