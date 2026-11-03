import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { USAGE_RANGES } from '../../host/usage/types.ts'
import type {
  UsageCall,
  UsageRange,
  UsageSource,
  UsageSummary,
  UsageTokens,
} from '../../host/usage/types.ts'
import styles from '../styles.module.css'
import { UsageHeatmapChart, UsageRankChart, UsageShareBar } from './usage-chart.tsx'
import type { UsageChartSlice } from './usage-chart.tsx'
import { formatCnyAmount, formatTokenCount, formatUsageWhen } from './usage-format.ts'

const SOURCE_LABEL = {
  optimize: 'usageSource_optimize',
  predict: 'usageSource_predict',
  compact: 'usageSource_compact',
  autoClassifier: 'usageSource_autoClassifier',
  session: 'usageSource_session',
  compaction: 'usageSource_compaction',
  sessionTitle: 'usageSource_sessionTitle',
  other: 'usageSource_other',
} as const

const SOURCE_COLOR: Record<UsageSource, string> = {
  optimize: '#3d7cf5',
  predict: '#6b7cff',
  compact: '#1f9a6a',
  autoClassifier: '#3aa88f',
  session: '#c9921a',
  compaction: '#c96b45',
  sessionTitle: '#b87a2e',
  other: '#7a8496',
}

const MODEL_COLORS = ['#3d7cf5', '#1f9a6a', '#c9921a', '#c96b45', '#6b7cff', '#3aa88f', '#b87a2e', '#7a8496'] as const

const RANGE_LABEL = {
  today: 'usageRange_today',
  '7d': 'usageRange_7d',
  '30d': 'usageRange_30d',
  all: 'usageRange_all',
} as const

/** Leave this much free height under the charts before inlining call rows. */
const RECENT_INLINE_MIN_PX = 176

function billedVolume(tokens: UsageTokens): number {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
}

function sourceSlices(
  summary: UsageSummary,
  t: TranslateNS<'agent-enhancer'>,
): UsageChartSlice[] {
  return summary.sources.flatMap(line => {
    const tokens = billedVolume(line)
    if (tokens <= 0) return []
    return [{
      id: line.source,
      label: t(SOURCE_LABEL[line.source]),
      tokens,
      color: SOURCE_COLOR[line.source],
    }]
  })
}

function modelLabel(
  provider: string,
  model: string,
  reasoningEffort: string,
  t: TranslateNS<'agent-enhancer'>,
): string {
  if (reasoningEffort === '') {
    return t('usageModelRoute', { provider, model })
  }
  return t('usageModelRouteEffort', { provider, model, effort: reasoningEffort })
}

function modelSlices(
  summary: UsageSummary,
  t: TranslateNS<'agent-enhancer'>,
): UsageChartSlice[] {
  const totals = new Map<string, {
    provider: string
    model: string
    reasoningEffort: string
    tokens: number
  }>()
  for (const source of summary.sources) {
    for (const model of source.models) {
      const key = `${model.provider}\0${model.model}\0${model.reasoningEffort}`
      const current = totals.get(key)
      const tokens = billedVolume(model)
      if (current === undefined) {
        totals.set(key, {
          provider: model.provider,
          model: model.model,
          reasoningEffort: model.reasoningEffort,
          tokens,
        })
      } else {
        current.tokens += tokens
      }
    }
  }
  return [...totals.values()]
    .filter(item => item.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens)
    .map((item, index) => ({
      id: `${item.provider}/${item.model}/${item.reasoningEffort}`,
      label: modelLabel(item.provider, item.model, item.reasoningEffort, t),
      tokens: item.tokens,
      color: MODEL_COLORS[index % MODEL_COLORS.length]!,
    }))
}

function BucketStrip({
  summary,
  t,
}: {
  readonly summary: UsageSummary
  readonly t: TranslateNS<'agent-enhancer'>
}) {
  // Cache write is real on Anthropic / some OpenAI routes; DeepSeek never
  // reports it, so hide the tile until a provider actually returns a count.
  const items: Array<{ readonly id: string, readonly label: string, readonly value: number }> = [
    { id: 'input', label: t('usageBucketInput'), value: summary.inputTokens },
    { id: 'output', label: t('usageBucketOutput'), value: summary.outputTokens },
    { id: 'cacheRead', label: t('usageBucketCacheRead'), value: summary.cacheReadTokens },
  ]
  if (summary.cacheWriteTokens > 0) {
    items.push({
      id: 'cacheWrite',
      label: t('usageBucketCacheWrite'),
      value: summary.cacheWriteTokens,
    })
  }
  return (
    <div className={styles.usageBuckets} aria-label={t('usageBuckets')}>
      {items.map(item => (
        <div key={item.id} className={styles.usageBucket}>
          <span className={styles.usageBucketLabel}>{item.label}</span>
          <span className={styles.usageBucketValue}>{formatTokenCount(item.value)}</span>
        </div>
      ))}
    </div>
  )
}

function RecentRows({
  calls,
  t,
  limit,
}: {
  readonly calls: readonly UsageCall[]
  readonly t: TranslateNS<'agent-enhancer'>
  readonly limit?: number
}) {
  const rows = limit === undefined ? calls : calls.slice(0, limit)
  return (
    <ol className={styles.usageRecentList}>
      {rows.map((call, index) => (
        <li
          key={`${call.at}:${index}:${call.source}:${call.provider}:${call.model}`}
          className={styles.usageRecentItem}
        >
          <div className={styles.usageRecentMain}>
            <span className={styles.usageRecentSource}>{t(SOURCE_LABEL[call.source])}</span>
            <span className={styles.usageRecentWhen}>{formatUsageWhen(call.at)}</span>
          </div>
          <div className={styles.usageRecentRoute}>
            <span>{t('usageRecordModel', { model: call.model })}</span>
            <span className={styles.usageRecentProvider}>
              {t('usageRecordProvider', { provider: call.provider })}
            </span>
            {call.reasoningEffort !== '' && (
              <span>{t('usageRecordEffort', { effort: call.reasoningEffort })}</span>
            )}
          </div>
          <div className={styles.usageRecentTokens}>
            <span>{t('usageRecordInput', { tokens: formatTokenCount(call.inputTokens) })}</span>
            <span>{t('usageRecordOutput', { tokens: formatTokenCount(call.outputTokens) })}</span>
            {call.cacheReadTokens > 0 && (
              <span>
                {t('usageRecordCacheRead', { tokens: formatTokenCount(call.cacheReadTokens) })}
              </span>
            )}
            {call.cacheWriteTokens > 0 && (
              <span>
                {t('usageRecordCacheWrite', { tokens: formatTokenCount(call.cacheWriteTokens) })}
              </span>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

export interface UsagePanelProps {
  readonly t: TranslateNS<'agent-enhancer'>
  readonly loadUsage?: (range: UsageRange) => Promise<UsageSummary>
}

export function UsagePanel({ t, loadUsage }: UsagePanelProps) {
  const [range, setRange] = useState<UsageRange>('7d')
  const [view, setView] = useState<'overview' | 'records'>('overview')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(loadUsage !== undefined)
  const [failed, setFailed] = useState(false)
  const [inlineRecent, setInlineRecent] = useState(false)
  const requestId = useRef(0)
  const shellRef = useRef<HTMLElement | null>(null)
  const chartsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (loadUsage === undefined) return undefined
    const id = ++requestId.current
    setLoading(true)
    setFailed(false)
    void loadUsage(range).then(
      value => {
        if (requestId.current !== id) return
        setSummary(value)
        setLoading(false)
      },
      () => {
        if (requestId.current !== id) return
        setFailed(true)
        setLoading(false)
      },
    )
    return undefined
  }, [loadUsage, range])

  useLayoutEffect(() => {
    if (view !== 'overview') return undefined
    const shell = shellRef.current
    const charts = chartsRef.current
    if (shell === null || charts === null) return undefined
    if (typeof ResizeObserver === 'undefined') {
      setInlineRecent(false)
      return undefined
    }

    const measure = () => {
      const leftover = shell.clientHeight - charts.offsetHeight - 24
      setInlineRecent(leftover >= RECENT_INLINE_MIN_PX)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(shell)
    observer.observe(charts)
    return () => { observer.disconnect() }
  }, [view, summary, range, loading])

  const visible = summary?.range === range ? summary : null

  const reload = () => {
    const id = ++requestId.current
    if (loadUsage === undefined) return
    setLoading(true)
    setFailed(false)
    void loadUsage(range).then(
      value => {
        if (requestId.current !== id) return
        setSummary(value)
        setLoading(false)
      },
      () => {
        if (requestId.current !== id) return
        setFailed(true)
        setLoading(false)
      },
    )
  }

  if (view === 'records') {
    return (
      <section
        aria-label={t('usageRecent')}
        aria-busy={loading}
        className={styles.usagePanel}
        data-usage-view="records"
      >
        <header className={styles.usageHeader}>
          <div className={styles.usageRecordsToolbar}>
            <button
              type="button"
              className={styles.usageBack}
              onClick={() => { setView('overview') }}
            >
              {t('usageBack')}
            </button>
            <button
              type="button"
              className={styles.usageRefresh}
              disabled={loading || loadUsage === undefined}
              onClick={reload}
            >
              {t('usageRefresh')}
            </button>
          </div>
          <h2 className={styles.usageTitle}>{t('usageRecent')}</h2>
          <p className={styles.usageNote}>{t('usageRecordsHint')}</p>
        </header>
        {visible === null || visible.recent.length === 0 ? (
          <p className={styles.usageEmpty}>{t('usageRecordsEmpty')}</p>
        ) : (
          <RecentRows calls={visible.recent} t={t} />
        )}
      </section>
    )
  }

  return (
    <section
      ref={shellRef}
      aria-label={t('usageTitle')}
      aria-busy={loading}
      className={styles.usagePanel}
      data-usage-view="overview"
    >
      <header className={styles.usageHero}>
        <div className={styles.usageHeroCopy}>
          <h2 className={styles.usageTitle}>{t('usageTitle')}</h2>
          <p className={styles.usageNote}>{t('usageNote')}</p>
          {visible !== null && visible.calls > 0 && (
            <div className={styles.usageMoneyBlock}>
              <span className={styles.usageEstimate}>
                {t('usageEstimateLabel', { amount: formatCnyAmount(visible.money.estimatedCost) })}
              </span>
              <span className={styles.usageEstimateHint}>{t('usageEstimateHint')}</span>
              {visible.money.unpricedCalls > 0 && (
                <span className={styles.usageUnpriced}>
                  {t('usageUnpriced', { count: formatTokenCount(visible.money.unpricedCalls) })}
                </span>
              )}
            </div>
          )}
        </div>
        {visible !== null && visible.calls > 0 && (
          <div className={styles.usageHeroTotal}>
            <span className={styles.usageHeroTotalValue}>
              {formatTokenCount(billedVolume(visible))}
            </span>
            <span className={styles.usageHeroTotalLabel}>{t('usageTotalLabel')}</span>
          </div>
        )}
      </header>

      {loadUsage === undefined ? <p role="status">{t('usageUnavailable')}</p> : <>
        <div className={styles.usageToolbar}>
          <div role="group" aria-label={t('usageRangeLabel')} className={styles.usageRanges}>
            {USAGE_RANGES.map(item => (
              <button
                key={item}
                type="button"
                className={styles.usageRange}
                aria-pressed={item === range}
                disabled={loading}
                onClick={() => { setRange(item) }}
              >
                {t(RANGE_LABEL[item])}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={styles.usageRefresh}
            disabled={loading}
            onClick={reload}
          >
            {t('usageRefresh')}
          </button>
        </div>

        {loading && visible === null && <p role="status">{t('usageLoading')}</p>}
        {failed && (
          <p role="status">
            {t('usageLoadFailed')}{' '}
            <button type="button" className={styles.settingsConfigure} onClick={reload}>
              {t('usageRetry')}
            </button>
          </p>
        )}

        {visible !== null && visible.calls === 0 && (
          <p className={styles.usageEmpty}>{t('usageEmpty')}</p>
        )}

        {visible !== null && visible.calls > 0 && (
          <>
            <div ref={chartsRef} className={styles.usageCharts}>
              <BucketStrip summary={visible} t={t} />
              <p className={styles.usageBucketMeta}>
                {t('usageCalls', { count: formatTokenCount(visible.calls) })}
                {visible.reasoningTokens > 0
                  ? ` · ${t('usageReasoningNote', { tokens: formatTokenCount(visible.reasoningTokens) })}`
                  : ''}
              </p>
              <UsageHeatmapChart
                title={t('usageHeatmap')}
                hint={visible.heatmap.grain === 'hour'
                  ? t('usageHeatmapHourHint')
                  : t('usageHeatmapHint')}
                heatmap={visible.heatmap}
                emptyLabel={t('usageChartEmpty')}
                callsLabel={count => t('usageCalls', { count: formatTokenCount(count) })}
              />
              <UsageShareBar
                title={t('usageShareBar')}
                slices={sourceSlices(visible, t)}
                emptyLabel={t('usageChartEmpty')}
              />
              <UsageRankChart
                title={t('usageChartModels')}
                slices={modelSlices(visible, t)}
                emptyLabel={t('usageChartEmpty')}
              />
            </div>

            <footer className={styles.usageFooter}>
              {inlineRecent && visible.recent.length > 0 ? (
                <div className={styles.usageRecentPreview}>
                  <div className={styles.usageRecentHead}>
                    <h3 className={styles.usageSectionTitle}>{t('usageRecent')}</h3>
                    <button
                      type="button"
                      className={styles.usageLink}
                      onClick={() => { setView('records') }}
                    >
                      {t('usageRecordsOpen')}
                    </button>
                  </div>
                  <RecentRows calls={visible.recent} t={t} limit={3} />
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.usageRecordsEntry}
                  onClick={() => { setView('records') }}
                  disabled={visible.recent.length === 0}
                >
                  <span>{t('usageRecent')}</span>
                  <span className={styles.usageRecordsEntryMeta}>
                    {visible.recent.length === 0
                      ? t('usageRecordsEmpty')
                      : t('usageCalls', { count: formatTokenCount(visible.recent.length) })}
                    {' ›'}
                  </span>
                </button>
              )}
            </footer>
          </>
        )}

        <p className={styles.usageRetention}>{t('usageRetention')}</p>
      </>}
    </section>
  )
}
