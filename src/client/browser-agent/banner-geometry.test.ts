import { describe, expect, it } from 'vitest'
import { BANNER_GAP, MIN_BANNER_ROOM, bannerRightInset } from './banner-geometry.ts'

describe('bannerRightInset', () => {
  it('keeps the normal gap when the right sidebar is closed', () => {
    expect(bannerRightInset(0, 1440)).toBe(BANNER_GAP)
    expect(bannerRightInset(Number.NaN, 1440)).toBe(BANNER_GAP)
  })

  it('steps left of an open panel by its width plus the gap', () => {
    expect(bannerRightInset(360, 1440)).toBe(360 + BANNER_GAP)
    expect(bannerRightInset(420, 1200)).toBe(420 + BANNER_GAP)
  })

  it('keeps room for the card itself so a fullscreen panel cannot push it away', () => {
    expect(bannerRightInset(1440, 1440)).toBe(1440 - MIN_BANNER_ROOM)
    expect(bannerRightInset(900, 900)).toBe(900 - MIN_BANNER_ROOM)
  })

  it('never goes past the plain gap on a narrow viewport', () => {
    expect(bannerRightInset(400, 300)).toBe(BANNER_GAP)
  })
})
