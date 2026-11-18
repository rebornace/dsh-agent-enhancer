import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RunAlertDedupe } from '../src/client/run-alerts/dedupe.ts'
import { detectSessionError, detectStatusEdges } from '../src/client/run-alerts/detect.ts'
import { deliverChannel, isAway, shouldDeliverAlert } from '../src/client/run-alerts/gate.ts'
import { visiblePendingKind } from '../src/client/run-alerts/pending-kind.ts'
import type { SessionStatusFace, SessionStatusMap } from '../src/client/run-alerts/types.ts'
import { SETTINGS_FEATURE_GROUPS } from '../src/client/dsh/settings-catalog.ts'
import { MODULES, resolveRunAlertsLevel } from '../src/config.ts'

const sid = 'sess-a' as SessionId

function mapOf(entries: ReadonlyArray<readonly [SessionId, SessionStatusFace]>): SessionStatusMap {
  return new Map(entries)
}

describe('run alerts gate', () => {
  it('hidden level only fires when the document is hidden', () => {
    expect(shouldDeliverAlert({
      level: 'hidden',
      documentHidden: false,
      windowFocused: false,
      isMainView: true,
    })).toBe(false)
    expect(shouldDeliverAlert({
      level: 'hidden',
      documentHidden: true,
      windowFocused: false,
      isMainView: true,
    })).toBe(true)
  })

  it('unfocused level covers blur, dual-monitor, and other sessions', () => {
    expect(shouldDeliverAlert({
      level: 'unfocused',
      documentHidden: false,
      windowFocused: true,
      isMainView: true,
    })).toBe(false)
    expect(shouldDeliverAlert({
      level: 'unfocused',
      documentHidden: false,
      windowFocused: false,
      isMainView: true,
    })).toBe(true)
    expect(shouldDeliverAlert({
      level: 'unfocused',
      documentHidden: false,
      windowFocused: true,
      isMainView: false,
    })).toBe(true)
  })

  it('always level never suppresses', () => {
    expect(shouldDeliverAlert({
      level: 'always',
      documentHidden: false,
      windowFocused: true,
      isMainView: true,
    })).toBe(true)
  })

  it('prefers system notification when hidden or unfocused', () => {
    expect(deliverChannel({ documentHidden: true, windowFocused: true })).toBe('notification')
    expect(deliverChannel({ documentHidden: false, windowFocused: false })).toBe('notification')
    expect(deliverChannel({ documentHidden: false, windowFocused: true })).toBe('toast')
  })

  it('treats blur as away', () => {
    expect(isAway(false, true)).toBe(false)
    expect(isAway(false, false)).toBe(true)
    expect(isAway(true, true)).toBe(true)
  })
})

describe('run alerts detect', () => {
  it('emits finished when completionUnread rises', () => {
    const previous = mapOf([[sid, { running: false, completionUnread: false }]])
    const next = mapOf([[sid, { running: false, completionUnread: true }]])
    expect(detectStatusEdges(previous, next)).toEqual([
      { sessionId: sid, kind: 'finished' },
    ])
  })

  it('emits finished on running drop only while away', () => {
    const previous = mapOf([[sid, { running: true, completionUnread: false }]])
    const next = mapOf([[sid, { running: false, completionUnread: false }]])
    expect(detectStatusEdges(previous, next, { away: false })).toEqual([])
    expect(detectStatusEdges(previous, next, { away: true })).toEqual([
      { sessionId: sid, kind: 'finished' },
    ])
  })

  it('dedupes unread + running-drop finish into one event', () => {
    const previous = mapOf([[sid, { running: true, completionUnread: false }]])
    const next = mapOf([[sid, { running: false, completionUnread: true }]])
    expect(detectStatusEdges(previous, next, { away: true })).toEqual([
      { sessionId: sid, kind: 'finished' },
    ])
  })

  it('emits pending when a visible pending kind appears', () => {
    const previous = mapOf([[sid, { running: true }]])
    const next = mapOf([[sid, {
      running: true,
      pendingInteraction: { kind: 'approval', key: 'a1' },
    }]])
    expect(detectStatusEdges(previous, next)).toEqual([
      { sessionId: sid, kind: 'pending', pendingKind: 'approval' },
    ])
  })

  it('ignores non-visible pending kinds', () => {
    expect(visiblePendingKind('approval')).toBe('approval')
    expect(visiblePendingKind('question')).toBe('question')
    expect(visiblePendingKind('plan-review')).toBe('plan-review')
    expect(visiblePendingKind('other')).toBeUndefined()
    const previous = mapOf([[sid, {}]])
    const next = mapOf([[sid, { pendingInteraction: { kind: 'secret-domain', key: 'x' } }]])
    expect(detectStatusEdges(previous, next)).toEqual([])
  })

  it('trims and truncates error messages', () => {
    const event = detectSessionError(sid, `  ${'x'.repeat(200)}  `)
    expect(event.kind).toBe('error')
    expect(event.message?.length).toBe(160)
  })
})

describe('run alerts dedupe', () => {
  it('suppresses duplicate finishes inside the window', () => {
    const dedupe = new RunAlertDedupe(1_000)
    expect(dedupe.accept({ sessionId: sid, kind: 'finished' }, 1000)).toBe(true)
    expect(dedupe.accept({ sessionId: sid, kind: 'finished' }, 1500)).toBe(false)
    expect(dedupe.accept({ sessionId: sid, kind: 'finished' }, 2500)).toBe(true)
  })
})

describe('run alerts settings wiring', () => {
  it('registers runAlerts in MODULES and the features catalog', () => {
    expect(MODULES).toContain('runAlerts')
    const modules = SETTINGS_FEATURE_GROUPS.flatMap(group => group.entries.map(entry => entry.module))
    expect(modules).toContain('runAlerts')
  })

  it('defaults and coerces runAlertsLevel', () => {
    expect(resolveRunAlertsLevel(undefined)).toBe('unfocused')
    expect(resolveRunAlertsLevel('always')).toBe('always')
    expect(resolveRunAlertsLevel('nope')).toBe('unfocused')
  })
})
