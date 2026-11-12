import { useEffect, useMemo, useState } from 'react'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextCompactResult } from '../../host/context-compact.ts'
import type {
  ContextInspectCategory,
  ContextInspectItem,
  ContextInspectKind,
  ContextInspectPressure,
  ContextInspectResult,
} from '../../host/context-inspect.ts'
import { AuxiliaryError } from '../../errors.ts'
import styles from '../styles.module.css'
import { ContextShareChart, colorForCategory, colorForKind } from './chart.tsx'
import type { ChartSlice } from './chart.tsx'
import { formatTokens, sharePercent } from './format.ts'
import { CategoryIcon, CompactIcon } from './icons.tsx'
import type { ContextInspectTabParams } from './tab.ts'
import { localizeItemTitle } from './title.ts'

const CATEGORIES: readonly ContextInspectCategory[] = ['system', 'tools', 'messages']
const KIND_ORDER: readonly ContextInspectKind[] = [
  'user', 'inject', 'assistant', 'tool', 'developer', 'system', 'tools',
]

export interface ContextInspectRightTabProps extends PropsRuntime<'sidebar.right.pane.tab'> {
  readonly inspect: (
    sessionId: SessionId,
    category: ContextInspectCategory,
    signal: AbortSignal,
  ) => Promise<ContextInspectResult>
  readonly compact: (
    sessionId: SessionId,
    signal: AbortSignal,
  ) => Promise<ContextCompactResult>
  readonly t: TranslateNS<'agent-enhancer'>
}

function paramsOf(raw: unknown): Partial<ContextInspectTabParams> {
  if (raw === null || typeof raw !== 'object') return {}
  return raw as Partial<ContextInspectTabParams>
}

function kindSlices(items: readonly ContextInspectItem[], labelOf: (kind: ContextInspectKind) => string): ChartSlice[] {
  const totals = new Map<ContextInspectKind, number>()
  for (const item of items) {
    totals.set(item.kind, (totals.get(item.kind) ?? 0) + item.tokens)
  }
  return KIND_ORDER
    .filter(kind => (totals.get(kind) ?? 0) > 0)
    .map(kind => ({
      id: kind,
      label: labelOf(kind),
      tokens: totals.get(kind)!,
      color: colorForKind(kind),
    }))
}

function kindLabelKey(kind: ContextInspectKind): string {
  switch (kind) {
    case 'system':
      return 'contextInspectCategory_system'
    case 'tools':
      return 'contextInspectCategory_tools'
    case 'user':
      return 'contextInspectKind_user'
    case 'inject':
      return 'contextInspectKind_inject'
    case 'assistant':
      return 'contextInspectKind_assistant'
    case 'tool':
      return 'contextInspectKind_tool'
    case 'developer':
      return 'contextInspectKind_developer'
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

function eventLabelKey(kind: 'compact' | 'prune' | 'replace'): string {
  switch (kind) {
    case 'compact':
      return 'contextInspectEvent_compact'
    case 'prune':
      return 'contextInspectEvent_prune'
    case 'replace':
      return 'contextInspectEvent_replace'
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

export function ContextInspectRightTab(props: ContextInspectRightTabProps) {
  const info = props.useTabInfo()
  const nav = info.tab.navigation
  const params = paramsOf(nav.params)
  const sessionId = params.sessionId
  const [category, setCategory] = useState<ContextInspectCategory>(params.category ?? 'messages')
  const [expandedId, setExpandedId] = useState<string | undefined>(params.itemId)
  const [result, setResult] = useState<ContextInspectResult | null>(null)
  const [overview, setOverview] = useState<Partial<Record<ContextInspectCategory, number>>>({})
  const [pressure, setPressure] = useState<ContextInspectPressure>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [compacting, setCompacting] = useState(false)
  const [compactNote, setCompactNote] = useState<string | null>(null)

  useEffect(() => {
    if (params.category !== undefined) setCategory(params.category)
    if (params.itemId !== undefined) setExpandedId(params.itemId)
  }, [params.category, params.itemId, nav.revision])

  useEffect(() => {
    if (sessionId === undefined) {
      setOverview({})
      setPressure({})
      return
    }
    const controller = new AbortController()
    void Promise.all(CATEGORIES.map(async entry => {
      try {
        const value = await props.inspect(sessionId, entry, controller.signal)
        return [entry, value] as const
      } catch {
        return [entry, null] as const
      }
    })).then(entries => {
      if (controller.signal.aborted) return
      const next: Partial<Record<ContextInspectCategory, number>> = {}
      let nextPressure: ContextInspectPressure = {}
      for (const [entry, value] of entries) {
        if (value === null) {
          next[entry] = 0
          continue
        }
        next[entry] = value.totalTokens
        if (value.pressure.projectedTokens !== undefined || value.pressure.contextWindow !== undefined) {
          nextPressure = value.pressure
        }
      }
      setOverview(next)
      setPressure(nextPressure)
    })
    return () => controller.abort()
  }, [sessionId, nav.revision, refreshToken, props.inspect])

  useEffect(() => {
    if (sessionId === undefined) {
      setResult(null)
      setError(props.t('contextInspectNoSession'))
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void props.inspect(sessionId, category, controller.signal).then(
      value => {
        if (controller.signal.aborted) return
        setResult(value)
        if (value.pressure.projectedTokens !== undefined || value.pressure.contextWindow !== undefined) {
          setPressure(value.pressure)
        }
        setLoading(false)
        setExpandedId(current => {
          if (current !== undefined && value.items.some(item => item.id === current)) return current
          return undefined
        })
      },
      () => {
        if (controller.signal.aborted) return
        setResult(null)
        setLoading(false)
        setError(props.t('contextInspectLoadFailed'))
      },
    )
    return () => controller.abort()
  }, [sessionId, category, nav.revision, refreshToken, props.inspect, props.t])

  async function runCompact() {
    if (sessionId === undefined || compacting) return
    setCompacting(true)
    setCompactNote(null)
    const controller = new AbortController()
    try {
      const value = await props.compact(sessionId, controller.signal)
      if (value.status === 'noop') {
        setCompactNote(props.t('contextInspectCompactNoop'))
      } else {
        setCompactNote(props.t('contextInspectCompactDone', {
          count: value.shadowedCount,
          tokens: formatTokens(value.shadowedTokens),
        }))
      }
      setRefreshToken(token => token + 1)
    } catch (error) {
      if (error instanceof AuxiliaryError) {
        switch (error.code) {
          case 'COMPACT_UNAVAILABLE':
            setCompactNote(props.t('contextInspectCompactUnavailable'))
            break
          case 'COMPACT_BUSY':
            setCompactNote(props.t('contextInspectCompactBusy'))
            break
          case 'COMPACT_SUMMARY':
            setCompactNote(props.t('contextInspectCompactSummary'))
            break
          case 'COMPACT_CHANGED':
            setCompactNote(props.t('contextInspectCompactChanged'))
            break
          case 'MODEL_UNAVAILABLE':
            setCompactNote(props.t('contextInspectCompactModel'))
            break
          case 'AUTO_ROUTE_UNCONFIGURED':
            setCompactNote(props.t('contextInspectCompactAutoUnconfigured'))
            break
          case 'COMPACT_FAILED':
          case 'SESSION_CHANGED':
          case 'MODEL_FAILED':
          case 'INVALID_OUTPUT':
          case 'ROLLBACK_FAILED':
          case 'SESSION_BUSY':
          case 'SESSION_DELETE_FAILED':
          case 'FILE_NOT_FOUND':
          case 'FILE_NOT_TEXT':
          case 'FILE_TOO_LARGE':
          case 'FILE_DENIED':
          case 'FILE_EDIT_FAILED':
            setCompactNote(props.t('contextInspectCompactFailed'))
            break
          default: {
            const _exhaustive: never = error.code
            setCompactNote(_exhaustive)
          }
        }
      } else {
        setCompactNote(props.t('contextInspectCompactFailed'))
      }
    } finally {
      setCompacting(false)
    }
  }

  const sorted = useMemo(() => {
    if (result === null) return [] as ContextInspectItem[]
    return [...result.items].sort((a, b) => b.tokens - a.tokens || a.title.localeCompare(b.title))
  }, [result])

  useEffect(() => {
    if (sorted.length === 1) setExpandedId(sorted[0]!.id)
  }, [sorted])

  const categoryTotal = result?.totalTokens ?? 0
  const overviewTotal = useMemo(
    () => CATEGORIES.reduce((sum, entry) => sum + (overview[entry] ?? 0), 0),
    [overview],
  )
  const shareBase = overviewTotal > 0 ? overviewTotal : categoryTotal

  // Translate labels at render time — `t` identity is stable across locale
  // switches, so memoizing translated strings would freeze the first language.
  const overviewSlices = useMemo((): ChartSlice[] => (
    CATEGORIES
      .map(entry => ({
        id: entry,
        label: entry,
        tokens: overview[entry] ?? 0,
        color: colorForCategory(entry),
      }))
      .filter(slice => slice.tokens > 0)
  ), [overview])

  const messageSlices = useMemo(
    () => kindSlices(sorted, kind => kind),
    [sorted],
  )

  const localizedOverviewSlices = overviewSlices.map(slice => ({
    ...slice,
    label: props.t(`contextInspectCategory_${slice.id as ContextInspectCategory}`),
  }))
  const localizedMessageSlices = messageSlices.map(slice => ({
    ...slice,
    label: props.t(kindLabelKey(slice.id as ContextInspectKind) as never),
  }))

  const chartSlices = category === 'messages' && localizedMessageSlices.length > 1
    ? localizedMessageSlices
    : localizedOverviewSlices.length > 0
      ? localizedOverviewSlices
      : localizedMessageSlices
  const chartTitle = category === 'messages' && localizedMessageSlices.length > 1
    ? props.t('contextInspectChartMessages')
    : localizedOverviewSlices.length > 0
      ? props.t('contextInspectChartOverview')
      : props.t('contextInspectChartCategory')
  const fillExpanded = sorted.length === 1
  const events = result?.events ?? []

  return (
    <div className={styles.contextRightPanel} aria-label={props.t('contextInspectDetailTitle')}>
      <header className={styles.contextRightHeader}>
        <div className={styles.contextRightTitleRow}>
          <h2 className={styles.contextRightTitle}>{props.t('contextInspectDetailTitle')}</h2>
          <span className={styles.contextRightMeta}>
            {result === null
              ? props.t('contextInspectApproxBadge')
              : props.t('contextInspectApproxTotal', { tokens: formatTokens(categoryTotal) })}
          </span>
        </div>
        <div className={styles.contextRightSegments} role="tablist" aria-label={props.t('contextInspectCategories')}>
          {CATEGORIES.map(entry => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={entry === category}
              className={entry === category ? styles.contextRightSegmentActive : styles.contextRightSegment}
              onClick={() => setCategory(entry)}
            >
              <CategoryIcon category={entry} />
              <span>{props.t(`contextInspectCategory_${entry}`)}</span>
            </button>
          ))}
        </div>
      </header>

      {!loading && error === null ? (
        <ContextShareChart
          title={chartTitle}
          totalLabel={props.t('contextInspectApproxBadge')}
          slices={chartSlices}
          emptyLabel={props.t('contextInspectEmpty')}
          pressure={pressure}
          headroomLabel={props.t('contextInspectHeadroom')}
          occupiedLabel={props.t('contextInspectOccupied')}
        />
      ) : null}

      {sessionId !== undefined && error === null ? (
        <div className={styles.contextCompactBar}>
          <button
            type="button"
            className={styles.contextCompactButton}
            disabled={compacting || loading}
            aria-label={compacting ? props.t('contextInspectCompacting') : props.t('contextInspectCompact')}
            title={props.t('contextInspectCompactHint')}
            onClick={() => { void runCompact() }}
          >
            <CompactIcon />
            <span className={styles.contextCompactButtonLabel}>
              {compacting ? props.t('contextInspectCompacting') : props.t('contextInspectCompact')}
            </span>
          </button>
          {compactNote !== null ? (
            <p className={styles.contextCompactNote} role="status">{compactNote}</p>
          ) : (
            <p className={styles.contextCompactHint}>{props.t('contextInspectCompactHint')}</p>
          )}
        </div>
      ) : null}

      {!loading && error === null && events.length > 0 ? (
        <div className={styles.contextEventRow} aria-label={props.t('contextInspectEvents')}>
          {events.map(event => (
            <span
              key={event.id}
              className={
                event.kind === 'compact' ? styles.contextEventChipCompact
                  : event.kind === 'prune' ? styles.contextEventChipPrune
                    : styles.contextEventChip
              }
              title={`${props.t(eventLabelKey(event.kind) as never)}${event.shadowed > 0 ? ` · ${event.shadowed}` : ''}`}
            >
              {props.t(eventLabelKey(event.kind) as never)}
              {event.shadowed > 0 ? ` · ${event.shadowed}` : ''}
            </span>
          ))}
        </div>
      ) : null}

      {loading ? (
        <p className={styles.contextRightStatus} role="status">{props.t('contextInspectLoading')}</p>
      ) : null}
      {error !== null ? (
        <p className={styles.contextRightStatus} role="alert">{error}</p>
      ) : null}

      {!loading && error === null && sorted.length === 0 ? (
        <p className={styles.contextRightStatus}>{props.t('contextInspectEmpty')}</p>
      ) : null}

      {sorted.length > 0 ? (
        <div
          className={fillExpanded ? styles.contextRightListFill : styles.contextRightScroll}
          role="list"
          aria-label={props.t(`contextInspectCategory_${category}`)}
        >
          {sorted.map(item => {
            const share = sharePercent(item.tokens, shareBase)
            const expanded = item.id === expandedId
            const color = colorForKind(item.kind)
            const itemClass = expanded
              ? (fillExpanded ? styles.contextRightItemActiveFill : styles.contextRightItemActive)
              : styles.contextRightItem
            return (
              <div key={item.id} className={itemClass} role="listitem">
                <button
                  type="button"
                  className={styles.contextRightRow}
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(current => current === item.id ? undefined : item.id)}
                >
                  <span
                    className={styles.contextRightItemDot}
                    style={{ background: color }}
                    aria-hidden="true"
                  />
                  <div className={styles.contextRightRowMain}>
                    <div className={styles.contextRightRowTitle}>
                      <span>{localizeItemTitle(item, props.t)}</span>
                      {item.replaced ? (
                        <span className={styles.contextRightBadge}>{props.t('contextInspectReplaced')}</span>
                      ) : null}
                      {item.kind === 'inject' ? (
                        <span className={styles.contextRightBadgeMuted}>
                          {props.t('contextInspectKind_inject')}
                        </span>
                      ) : null}
                    </div>
                    {!expanded ? (
                      <div className={styles.contextRightRowPreview}>{item.detail}</div>
                    ) : null}
                    <div className={styles.contextRightBarTrack} aria-hidden="true">
                      <div
                        className={styles.contextRightBarFill}
                        style={{ width: `${share}%`, background: color }}
                      />
                    </div>
                  </div>
                  <div className={styles.contextRightRowTokens}>
                    ~{formatTokens(item.tokens)}
                    <span className={styles.contextRightShare}> · {share}%</span>
                  </div>
                </button>
                {expanded ? (
                  <section className={styles.contextRightDetail} aria-label={props.t('contextInspectItemDetail')}>
                    <pre className={styles.contextRightDetailBody}>{item.body}</pre>
                  </section>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}

      <footer className={styles.contextRightNote}>{props.t('contextInspectNote')}</footer>
    </div>
  )
}

export function ContextInspectRightTabTitle(props: PropsRuntime<'sidebar.right.pane.tab.title'> & {
  readonly t: TranslateNS<'agent-enhancer'>
}) {
  const info = props.useTabInfo()
  const params = paramsOf(info.tab.navigation.params)
  const category = params.category
  const label = category === undefined
    ? props.t('contextInspectDetailTitle')
    : props.t(`contextInspectCategory_${category}`)
  return <span>{label}</span>
}
