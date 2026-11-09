/**
 * Bind http(s) hrefs from real document anchors onto a11y nodes that lack a url property.
 * Universal: geometry (point-in-rect / nearest center) then loose name overlap.
 *
 * Canonical copy for PlaywrightDriver + tests. The MV3 extension keeps a JS twin in
 * Historical twin lived in `extensions/chrome-legacy/page-ops.js` (archived; not shipped).
 */

export interface ProximityNode {
  href?: string
  name?: string
  x?: number
  y?: number
  priority?: number
}

export interface ProximityAnchor {
  readonly href: string
  readonly name?: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

interface PreparedAnchor {
  readonly href: string
  readonly name: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly cx: number
  readonly cy: number
  readonly area: number
}

/**
 * @returns how many nodes gained an href
 */
export function attachHrefByProximity(
  nodes: ProximityNode[],
  anchors: ReadonlyArray<ProximityAnchor>,
): number {
  if (!Array.isArray(nodes) || !Array.isArray(anchors) || anchors.length === 0) return 0
  const prepared: PreparedAnchor[] = anchors
    .filter(a => a && /^https?:\/\//i.test(String(a.href || '')) && Number(a.w) > 0 && Number(a.h) > 0)
    .map(a => ({
      href: String(a.href),
      name: String(a.name || '').replace(/\s+/g, ' ').trim().toLowerCase(),
      x: Number(a.x),
      y: Number(a.y),
      w: Number(a.w),
      h: Number(a.h),
      cx: Number(a.x) + Number(a.w) / 2,
      cy: Number(a.y) + Number(a.h) / 2,
      area: Number(a.w) * Number(a.h),
    }))
  if (prepared.length === 0) return 0

  let attached = 0
  for (const node of nodes) {
    if (!node || (typeof node.href === 'string' && /^https?:\/\//i.test(node.href))) continue
    const nx = typeof node.x === 'number' ? node.x : Number.NaN
    const ny = typeof node.y === 'number' ? node.y : Number.NaN

    let best: PreparedAnchor | null = null
    let bestArea = Infinity
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      for (const a of prepared) {
        if (nx >= a.x && nx <= a.x + a.w && ny >= a.y && ny <= a.y + a.h) {
          if (a.area < bestArea) {
            bestArea = a.area
            best = a
          }
        }
      }
      if (best === null) {
        let bestDist = 96
        for (const a of prepared) {
          const dist = Math.hypot(nx - a.cx, ny - a.cy)
          if (dist < bestDist) {
            bestDist = dist
            best = a
          }
        }
      }
    }

    if (best === null) {
      const rawName = String(node.name || '').replace(/\s+/g, ' ').trim().toLowerCase()
      if (rawName.length >= 4 && rawName !== 'link' && rawName !== 'a' && rawName !== 'button') {
        for (const a of prepared) {
          if (!a.name || a.name.length < 4) continue
          if (a.name.includes(rawName) || rawName.includes(a.name)) {
            best = a
            break
          }
          const tokens = rawName.split(/[^0-9A-Za-z\u0080-\uffff]+/).filter(t => t.length >= 4)
          if (tokens.some(t => a.name.includes(t))) {
            best = a
            break
          }
        }
      }
    }

    if (best === null) continue
    node.href = best.href
    node.priority = 0
    attached += 1
  }
  return attached
}
