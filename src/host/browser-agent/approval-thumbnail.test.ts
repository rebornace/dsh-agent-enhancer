import { describe, expect, it } from 'vitest'
import {
  MAX_THUMBNAIL_BASE64,
  THUMBNAIL_MAX_HEIGHT,
  THUMBNAIL_MAX_WIDTH,
  clampThumbnailClip,
  keepThumbnail,
} from './approval-thumbnail.ts'

const viewport = { width: 1280, height: 800 }

describe('clampThumbnailClip', () => {
  it('surrounds a small control with padding', () => {
    expect(clampThumbnailClip({ x: 100, y: 200, width: 80, height: 24 }, viewport)).toEqual({
      x: 88, y: 188, width: 104, height: 48,
    })
  })

  it('clamps to the viewport edges so the screenshot cannot fail', () => {
    const topLeft = clampThumbnailClip({ x: 2, y: 2, width: 40, height: 20 }, viewport)
    expect(topLeft).toMatchObject({ x: 0, y: 0 })
    const bottomRight = clampThumbnailClip({ x: 1240, y: 780, width: 30, height: 15 }, viewport)
    expect(bottomRight!.x + bottomRight!.width).toBeLessThanOrEqual(viewport.width)
    expect(bottomRight!.y + bottomRight!.height).toBeLessThanOrEqual(viewport.height)
  })

  it('caps a large container instead of shipping the whole page', () => {
    const clip = clampThumbnailClip({ x: 0, y: 0, width: 1200, height: 700 }, viewport)
    expect(clip).toMatchObject({ x: 0, y: 0, width: THUMBNAIL_MAX_WIDTH, height: THUMBNAIL_MAX_HEIGHT })
  })

  it('drops elements that are off screen or have no area', () => {
    expect(clampThumbnailClip({ x: 2000, y: 200, width: 40, height: 20 }, viewport)).toBeNull()
    expect(clampThumbnailClip({ x: 10, y: 10, width: 0, height: 20 }, viewport)).toBeNull()
    expect(clampThumbnailClip({ x: Number.NaN, y: 10, width: 20, height: 20 }, viewport)).toBeNull()
  })
})

describe('keepThumbnail', () => {
  it('accepts a normal crop and refuses an oversized payload', () => {
    expect(keepThumbnail('abc')).toBe(true)
    expect(keepThumbnail('')).toBe(false)
    expect(keepThumbnail('a'.repeat(MAX_THUMBNAIL_BASE64 + 1))).toBe(false)
  })
})
