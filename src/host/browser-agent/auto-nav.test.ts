import { describe, expect, it } from 'vitest'
import { namesLooselyMatch, pickAutoNavigateHref } from './auto-nav.ts'

describe('pickAutoNavigateHref', () => {
  it('does not hop to unrelated chrome just because the path is deeper', () => {
    const picked = pickAutoNavigateHref(
      [
        { href: 'https://example.com/v/popular/all', name: 'https://example.com/v/popular/all' },
        { href: 'https://example.com/anime/', name: 'anime' },
      ],
      'https://example.com/',
      '我开个救护车怎么这么惨',
    )
    expect(picked).toBeNull()
  })

  it('picks a same-origin link whose name matches the dead click', () => {
    const picked = pickAutoNavigateHref(
      [
        { href: 'https://example.com/v/popular/all', name: '热门' },
        { href: 'https://example.com/video/42', name: '我开个救护车怎么这么惨' },
      ],
      'https://example.com/',
      '我开个救护车怎么这么惨',
    )
    expect(picked).toBe('https://example.com/video/42')
  })
})

describe('namesLooselyMatch', () => {
  it('matches shared substantive tokens', () => {
    expect(namesLooselyMatch('我开个救护车怎么这么惨', '标题：我开个救护车怎么这么惨 - UP主')).toBe(true)
    expect(namesLooselyMatch('我开个救护车怎么这么惨', '热门')).toBe(false)
  })
})
