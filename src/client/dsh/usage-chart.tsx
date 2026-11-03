import { useId, useState } from 'react'
import type { UsageHeatmap } from '../../host/usage/types.ts'
import styles from '../styles.module.css'
import { sharePercent } from '../context/format.ts'
import { formatTokenCount } from './usage-format.ts'

export interface UsageChartSlice {
  readonly id: string
  readonly label: string
  readonly tokens: number
  readonly color: string
}

function heatLevel(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || max <= 0) return 0
  const ratio = tokens / max
  if (ratio < 0.2) return 1
  if (ratio < 0.4) return 2
  if (ratio < 0.7) return 3
  return 4
}

/** Day/hour intensity grid — signature chart for the bill panel. */
export function UsageHeatmapChart(props: {
  readonly title: string
  readonly hint: string
  readonly heatmap: UsageHeatmap
  readonly emptyLabel: string
  readonly callsLabel: (count: number) => string
}) {
  const tipId = useId()
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const max = props.heatmap.cells.reduce((high, cell) => Math.max(high, cell.tokens), 0)
  const empty = max <= 0
  const hovered = hoveredKey === null
    ? undefined
    : props.heatmap.cells.find(cell => cell.key === hoveredKey)
  const grainClass = props.heatmap.grain === 'hour'
    ? styles.usageHeatGridHour
    : styles.usageHeatGridDay

  return (
    <section className={styles.usageChart} aria-label={props.title}>
      <div className={styles.usageChartHead}>
        <h3 className={styles.usageSectionTitle}>{props.title}</h3>
        <p className={styles.usageChartHint}>{props.hint}</p>
      </div>
      {empty ? (
        <p className={styles.usageEmptyInline}>{props.emptyLabel}</p>
      ) : (
        <div className={styles.usageHeatBody}>
          <div
            className={`${styles.usageHeatGrid} ${grainClass}`}
            role="img"
            aria-labelledby={tipId}
            onMouseLeave={() => { setHoveredKey(null) }}
          >
            {props.heatmap.cells.map(cell => {
              const level = heatLevel(cell.tokens, max)
              const active = hoveredKey === null || hoveredKey === cell.key
              return (
                <button
                  key={cell.key}
                  type="button"
                  className={active ? styles.usageHeatCell : styles.usageHeatCellDim}
                  data-level={level}
                  aria-label={`${cell.label}: ${formatTokenCount(cell.tokens)}`}
                  onMouseEnter={() => { setHoveredKey(cell.key) }}
                  onFocus={() => { setHoveredKey(cell.key) }}
                  onBlur={() => { setHoveredKey(null) }}
                >
                  <span className={styles.usageHeatLabel}>{cell.label}</span>
                </button>
              )
            })}
          </div>
          <div className={styles.usageHeatLegend} id={tipId}>
            {hovered !== undefined ? (
              <>
                <span className={styles.usageHeatTipValue}>
                  {formatTokenCount(hovered.tokens)}
                </span>
                <span className={styles.usageHeatTipMeta}>
                  {hovered.label}
                  {' · '}
                  {props.callsLabel(hovered.calls)}
                </span>
              </>
            ) : (
              <span className={styles.usageHeatScale} aria-hidden="true">
                <span data-level={0} />
                <span data-level={1} />
                <span data-level={2} />
                <span data-level={3} />
                <span data-level={4} />
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

/** Stacked feature share — readable when one or many features fire. */
export function UsageShareBar(props: {
  readonly title: string
  readonly slices: readonly UsageChartSlice[]
  readonly emptyLabel: string
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const total = props.slices.reduce((sum, slice) => sum + slice.tokens, 0)
  const empty = total <= 0 || props.slices.length === 0

  return (
    <section className={styles.usageChart} aria-label={props.title}>
      <h3 className={styles.usageSectionTitle}>{props.title}</h3>
      {empty ? (
        <p className={styles.usageEmptyInline}>{props.emptyLabel}</p>
      ) : (
        <div className={styles.usageShareBody} onMouseLeave={() => { setHoveredId(null) }}>
          <div className={styles.usageShareTrack} aria-hidden="true">
            {props.slices.map(slice => {
              const width = Math.max(2, (slice.tokens / total) * 100)
              const dim = hoveredId !== null && hoveredId !== slice.id
              return (
                <div
                  key={slice.id}
                  className={dim ? styles.usageShareSegmentDim : styles.usageShareSegment}
                  style={{ width: `${width}%`, background: slice.color }}
                  onMouseEnter={() => { setHoveredId(slice.id) }}
                />
              )
            })}
          </div>
          <ul className={styles.usageLegend}>
            {props.slices.map(slice => {
              const share = sharePercent(slice.tokens, total)
              const active = hoveredId === null || hoveredId === slice.id
              return (
                <li
                  key={slice.id}
                  className={active ? styles.usageLegendItem : styles.usageLegendItemDim}
                  onMouseEnter={() => { setHoveredId(slice.id) }}
                  onMouseLeave={() => { setHoveredId(null) }}
                >
                  <span className={styles.usageLegendSwatch} style={{ background: slice.color }} />
                  <span className={styles.usageLegendLabel}>{slice.label}</span>
                  <span className={styles.usageLegendMeta}>
                    {formatTokenCount(slice.tokens)}
                    <span className={styles.usageLegendShare}>{share}%</span>
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}

/** Ranked model bars. */
export function UsageRankChart(props: {
  readonly title: string
  readonly slices: readonly UsageChartSlice[]
  readonly emptyLabel: string
}) {
  const total = props.slices.reduce((sum, slice) => sum + slice.tokens, 0)
  const empty = total <= 0 || props.slices.length === 0
  const max = props.slices.reduce((high, slice) => Math.max(high, slice.tokens), 0)

  return (
    <section className={styles.usageChart} aria-label={props.title}>
      <h3 className={styles.usageSectionTitle}>{props.title}</h3>
      {empty ? (
        <p className={styles.usageEmptyInline}>{props.emptyLabel}</p>
      ) : (
        <ul className={styles.usageRankList}>
          {props.slices.map(slice => {
            const width = max <= 0 ? 0 : Math.max(6, Math.round((slice.tokens / max) * 100))
            return (
              <li key={slice.id} className={styles.usageRankItem}>
                <div className={styles.usageRankTop}>
                  <span className={styles.usageRankLabel}>{slice.label}</span>
                  <span className={styles.usageRankMeta}>
                    {formatTokenCount(slice.tokens)}
                    <span className={styles.usageLegendShare}>{sharePercent(slice.tokens, total)}%</span>
                  </span>
                </div>
                <div className={styles.usageRankTrack} aria-hidden="true">
                  <div
                    className={styles.usageRankFill}
                    style={{ width: `${width}%`, background: slice.color }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
