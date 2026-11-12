/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { placeQuoteChip } from './position.ts'

describe('placeQuoteChip', () => {
  it('keeps the chip above the selection when there is room', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    Object.defineProperty(window, 'CSS', {
      configurable: true,
      value: { supports: () => false },
    })
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: undefined,
    })

    const placed = placeQuoteChip({ left: 100, top: 200, right: 180, bottom: 220 })
    expect(placed.top).toBe(200 - 8 - 28)
    expect(placed.left).toBeGreaterThanOrEqual(4)
  })

  it('offsets WebKit client coords into layout origin for fixed placement', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    Object.defineProperty(window, 'CSS', {
      configurable: true,
      value: { supports: () => true },
    })
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        offsetLeft: 40,
        offsetTop: 24,
        width: 760,
        height: 560,
      },
    })

    const placed = placeQuoteChip({ left: 100, top: 200, right: 180, bottom: 220 })
    expect(placed.top).toBe((200 + 24) - 8 - 28)
    expect(placed.left).toBeGreaterThan(100)
  })
})
