import { useId, useState } from 'react'
import styles from '../styles.module.css'
import { formatTokens, sharePercent } from './format.ts'
import type {
  ContextInspectCategory,
  ContextInspectKind,
  ContextInspectPressure,
} from '../../host/context-inspect.ts'

export interface ChartSlice {
  readonly id: string
  readonly label: string
  readonly tokens: number
  readonly color: string
}

const CATEGORY_COLORS: Record<ContextInspectCategory, string> = {
  system: '#4c8bf5',
  tools: '#2f9e6b',
  messages: '#d4a017',
}

const KIND_COLORS: Record<ContextInspectKind, string> = {
  system: '#4c8bf5',
  tools: '#2f9e6b',
  user: '#5b8def',
  inject: '#7c8cff',
  assistant: '#d4a017',
  tool: '#2f9e6b',
  developer: '#8a94a6',
}

const ITEM_PALETTE = ['#4c8bf5', '#2f9e6b', '#d4a017', '#d97757', '#7c8cff', '#5cb8a0', '#c98b3b', '#8a94a6'] as const

export function colorForCategory(category: ContextInspectCategory): string {
  return CATEGORY_COLORS[category]
}

export function colorForKind(kind: ContextInspectKind): string {
  return KIND_COLORS[kind]
}

export function colorForItem(index: number): string {
  return ITEM_PALETTE[index % ITEM_PALETTE.length]!
}

/** Composition stack + legend meters + window headroom (Operate / DSH tokens). */
export function ContextShareChart(props: {
  readonly title: string
  readonly totalLabel: string
  readonly slices: readonly ChartSlice[]
  readonly emptyLabel: string
  readonly pressure?: ContextInspectPressure
  readonly headroomLabel: string
  readonly occupiedLabel: string
}) {
  const tipId = useId()
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const total = props.slices.reduce((sum, slice) => sum + slice.tokens, 0)
  const projected = props.pressure?.projectedTokens
  const window = props.pressure?.contextWindow
  const occupancy = projected !== undefined && window !== undefined && window > 0
    ? Math.min(100, Math.round((projected / window) * 1000) / 10)
    : undefined
  const remaining = projected !== undefined && window !== undefined
    ? Math.max(0, window - projected)
    : undefined
  const empty = total <= 0 || props.slices.length === 0
  const hovered = hoveredId === null
    ? undefined
    : props.slices.find(slice => slice.id === hoveredId)
  const tipText = hovered === undefined
    ? undefined
    : `${hovered.label} · ~${formatTokens(hovered.tokens)} · ${sharePercent(hovered.tokens, total)}%`

  return (
    <div className={styles.contextChart} aria-label={props.title}>
      <div className={styles.contextChartHeading}>
        <span className={styles.contextChartTitle}>{props.title}</span>
        {!empty ? (
          <span className={styles.contextChartTotal}>
            ~{formatTokens(total)}
            <span className={styles.contextChartTotalHint}> {props.totalLabel}</span>
          </span>
        ) : null}
      </div>

      {empty ? (
        <p className={styles.contextRightStatus}>{props.emptyLabel}</p>
      ) : (
        <>
          <div
            className={styles.contextStackWrap}
            onMouseLeave={() => setHoveredId(null)}
          >
            {tipText !== undefined ? (
              <div className={styles.contextChartTip} id={tipId} role="tooltip">
                <span
                  className={styles.contextChartTipSwatch}
                  style={{ background: hovered!.color }}
                />
                <span>{tipText}</span>
              </div>
            ) : null}
            <div className={styles.contextStack} aria-hidden="true">
              {props.slices.map(slice => {
                const active = hoveredId === null || hoveredId === slice.id
                return (
                  <span
                    key={slice.id}
                    className={active ? styles.contextStackSegment : styles.contextStackSegmentDim}
                    style={{
                      width: `${Math.max(1.5, (slice.tokens / total) * 100)}%`,
                      background: slice.color,
                    }}
                    onMouseEnter={() => setHoveredId(slice.id)}
                  />
                )
              })}
            </div>
          </div>

          <ul className={styles.contextChartLegend}>
            {props.slices.map(slice => {
              const share = sharePercent(slice.tokens, total)
              const active = hoveredId === null || hoveredId === slice.id
              return (
                <li
                  key={slice.id}
                  className={active ? styles.contextChartLegendItem : styles.contextChartLegendItemDim}
                  onMouseEnter={() => setHoveredId(slice.id)}
                  onMouseLeave={() => setHoveredId(null)}
                >
                  <span className={styles.contextChartSwatch} style={{ background: slice.color }} />
                  <div className={styles.contextChartLegendMain}>
                    <div className={styles.contextChartLegendTop}>
                      <span className={styles.contextChartLegendLabel}>{slice.label}</span>
                      <span className={styles.contextChartLegendMeta}>
                        ~{formatTokens(slice.tokens)} · {share}%
                      </span>
                    </div>
                    <div className={styles.contextChartLegendTrack}>
                      <div
                        className={styles.contextChartLegendFill}
                        style={{ width: `${share}%`, background: slice.color }}
                      />
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {projected !== undefined || window !== undefined ? (
        <div className={styles.contextHeadroom} aria-label={props.headroomLabel}>
          <div className={styles.contextHeadroomMeta}>
            <span>{props.occupiedLabel}</span>
            <span className={styles.contextHeadroomValue}>
              {projected !== undefined ? `~${formatTokens(projected)}` : '—'}
              {window !== undefined ? ` / ${formatTokens(window)}` : ''}
              {occupancy !== undefined ? ` · ${occupancy}%` : ''}
            </span>
          </div>
          {window !== undefined && projected !== undefined ? (
            <div className={styles.contextHeadroomTrack} aria-hidden="true">
              <div
                className={styles.contextHeadroomFill}
                style={{ width: `${Math.min(100, (projected / window) * 100)}%` }}
              />
            </div>
          ) : null}
          {remaining !== undefined ? (
            <div className={styles.contextHeadroomHint}>
              {props.headroomLabel}: ~{formatTokens(remaining)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
