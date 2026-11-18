import { describe, expect, it } from 'vitest'
import { attachHrefByProximity, type ProximityNode } from '../src/host/browser-agent/proximity.ts'

describe('attachHrefByProximity', () => {
  it('attaches the smallest containing anchor to an AX point', () => {
    const nodes: ProximityNode[] = [{ name: 'Video title', x: 120, y: 220, href: '', priority: 1 }]
    const anchors = [
      { href: 'https://example.com/section', name: 'section', x: 0, y: 0, w: 1000, h: 1000 },
      { href: 'https://example.com/item/1', name: 'Video title', x: 100, y: 200, w: 80, h: 80 },
    ]
    expect(attachHrefByProximity(nodes, anchors)).toBe(1)
    expect(nodes[0]?.href).toBe('https://example.com/item/1')
  })

  it('falls back to loose name overlap when geometry is missing', () => {
    const nodes: ProximityNode[] = [{ name: '这样建？几棵树苗能做什么？【Minecraft】', priority: 1 }]
    const anchors = [
      { href: 'https://example.com/v/popular/all', name: '热门', x: 0, y: 0, w: 40, h: 20 },
      {
        href: 'https://example.com/video/BV1',
        name: '这样建？几棵树苗能做什么？【Minecraft】',
        x: 10,
        y: 10,
        w: 40,
        h: 20,
      },
    ]
    expect(attachHrefByProximity(nodes, anchors)).toBe(1)
    expect(nodes[0]?.href).toBe('https://example.com/video/BV1')
  })

  it('does not invent matches for unrelated chrome labels', () => {
    const nodes: ProximityNode[] = [{ name: '这样建？几棵树苗能做什么？【Minecraft】', x: 500, y: 500, priority: 1 }]
    const anchors = [
      { href: 'https://example.com/v/popular/all', name: '热门', x: 0, y: 0, w: 40, h: 20 },
    ]
    expect(attachHrefByProximity(nodes, anchors)).toBe(0)
    expect(nodes[0]?.href).toBeFalsy()
  })

  it('skips nodes that already have an http(s) href', () => {
    const nodes: ProximityNode[] = [{ name: 'Keep', href: 'https://example.com/keep', x: 10, y: 10, priority: 0 }]
    const anchors = [
      { href: 'https://example.com/other', name: 'Keep', x: 0, y: 0, w: 40, h: 40 },
    ]
    expect(attachHrefByProximity(nodes, anchors)).toBe(0)
    expect(nodes[0]?.href).toBe('https://example.com/keep')
  })
})
