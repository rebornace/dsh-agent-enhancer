import { describe, expect, it } from 'vitest'
import {
  attachDemoTab,
  demoTabLegend,
  isSensitiveFieldName,
  pushDemoStep,
  mergeDemoSteps,
  sanitizeDemoSteps,
  summarizeDemoSteps,
  type DemoStep,
} from './demo.ts'

const click = (selector: string, at: number): DemoStep => ({
  kind: 'click',
  at,
  role: 'button',
  name: 'Save',
  selector,
})
const fill = (selector: string, field: string, value: string, at: number, masked = false): DemoStep => ({
  kind: 'fill',
  at,
  role: 'textbox',
  name: field,
  selector,
  field,
  value,
  masked,
})

describe('isSensitiveFieldName', () => {
  it('catches password, otp and token shapes', () => {
    for (const name of ['password', 'user_password', 'pw', 'otp', 'one-time-code', 'cvv', 'cardNumber', 'api_token']) {
      expect(isSensitiveFieldName(name), name).toBe(true)
    }
  })

  it('leaves ordinary fields alone', () => {
    for (const name of ['email', 'q', 'notes', 'plan']) {
      expect(isSensitiveFieldName(name), name).toBe(false)
    }
  })
})

describe('pushDemoStep', () => {
  it('collapses keystrokes into the final value', () => {
    const steps: DemoStep[] = []
    pushDemoStep(steps, fill('#q', 'q', 'c', 1))
    pushDemoStep(steps, fill('#q', 'q', 'co', 2))
    pushDemoStep(steps, fill('#q', 'q', 'coffee', 3))
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ value: 'coffee' })
  })

  it('drops the click that focused the field', () => {
    const steps: DemoStep[] = []
    pushDemoStep(steps, click('#q', 1))
    pushDemoStep(steps, fill('#q', 'q', 'coffee', 2))
    expect(steps.map(step => step.kind)).toEqual(['fill'])
  })

  it('keeps a click on a different element', () => {
    const steps: DemoStep[] = []
    pushDemoStep(steps, click('#save', 1))
    pushDemoStep(steps, fill('#q', 'q', 'coffee', 2))
    expect(steps.map(step => step.kind)).toEqual(['click', 'fill'])
  })

  it('does not fold across tabs, even for the same field', () => {
    const steps: DemoStep[] = []
    pushDemoStep(steps, attachDemoTab(fill('#q', 'q', 'ad', 1), { tabId: 1 }))
    pushDemoStep(steps, attachDemoTab(fill('#q', 'q', 'admin', 2), { tabId: 2 }))
    expect(steps).toHaveLength(2)
    expect(steps.map(step => step.tabId)).toEqual([1, 2])
  })
})

describe('attachDemoTab', () => {
  it('tags a page-side step with the tab that sent it', () => {
    const tagged = attachDemoTab(click('#a', 1), { tabId: 7, tabUrl: 'https://example.com/x' })
    expect(tagged).toMatchObject({ tabId: 7, tabUrl: 'https://example.com/x', selector: '#a' })
  })

  it('leaves a step alone when no tab is known', () => {
    const step = click('#a', 1)
    expect(attachDemoTab(step, {})).toBe(step)
  })
})

describe('mergeDemoSteps', () => {
  it('orders by time and drops an immediate repeat', () => {
    const steps = mergeDemoSteps(
      [click('#a', 20)],
      [{ kind: 'navigate', at: 10, url: 'https://example.com/' }, click('#a', 15)],
    )
    expect(steps.map(step => step.kind)).toEqual(['navigate', 'click'])
    expect(steps[1]).toMatchObject({ at: 15 })
  })

  it('keeps a genuine second click after other work', () => {
    const steps = mergeDemoSteps([click('#a', 10), fill('#q', 'q', 'x', 20), click('#a', 30)], [])
    expect(steps).toHaveLength(3)
  })

  it('keeps the same click in two tabs instead of deduping it away', () => {
    const steps = mergeDemoSteps(
      [
        attachDemoTab(click('#export', 10), { tabId: 1 }),
        attachDemoTab(click('#export', 20), { tabId: 2 }),
      ],
      [],
    )
    expect(steps.map(step => step.tabId)).toEqual([1, 2])
  })
})

describe('sanitizeDemoSteps', () => {
  it('masks a value that slipped through when the field looks secret', () => {
    const [step] = sanitizeDemoSteps([fill('#pw', 'password', 'hunter2', 1)])
    expect(step).toMatchObject({ value: '***', masked: true })
  })

  it('keeps ordinary values', () => {
    const [step] = sanitizeDemoSteps([fill('#q', 'q', 'coffee', 1)])
    expect(step).toMatchObject({ value: 'coffee', masked: false })
  })
})

describe('summarizeDemoSteps', () => {
  const steps: DemoStep[] = [
    { kind: 'navigate', at: 1, url: 'https://example.com/login' },
    click('#signin', 2),
    fill('#email', 'email', 'me@example.com', 3),
    fill('#pw', 'password', '***', 4, true),
    { kind: 'press', at: 5, key: 'Enter', selector: '#pw' },
  ]

  it('renders one line per step with masked values and a count', () => {
    const summary = summarizeDemoSteps(steps)
    expect(summary.shown).toBe(5)
    expect(summary.masked).toBe(1)
    expect(summary.lines[0]).toContain('navigate -> https://example.com/login')
    expect(summary.lines[2]).toContain('"me@example.com"')
    expect(summary.lines[3]).toContain('= ***')
    expect(summary.lines[4]).toContain('press Enter')
  })

  it('caps the list without losing the masked count of what it shows', () => {
    const summary = summarizeDemoSteps(steps, 3)
    expect(summary.shown).toBe(3)
    expect(summary.masked).toBe(0)
    expect(summary.lines).toHaveLength(3)
  })

  it('leaves a single-tab flow untagged, with no legend', () => {
    const tagged = steps.map(step => attachDemoTab(step, { tabId: 1, tabUrl: 'https://example.com/login' }))
    const summary = summarizeDemoSteps(tagged)
    expect(summary.multiTab).toBe(false)
    expect(summary.tabs).toEqual([{ tabId: 1, url: 'https://example.com/login' }])
    expect(summary.lines[0]).toBe('1. navigate -> https://example.com/login')
    expect(demoTabLegend(summary)).toEqual([])
  })

  it('tags every step once the flow crosses tabs and names each tab', () => {
    const tagged: DemoStep[] = [
      attachDemoTab({ kind: 'navigate', at: 1, url: 'https://example.com/' }, { tabId: 1, tabUrl: 'https://example.com/' }),
      attachDemoTab(click('#open', 2), { tabId: 1 }),
      attachDemoTab({ kind: 'navigate', at: 3, url: 'https://example.com/docs' }, { tabId: 2, tabUrl: 'https://example.com/docs' }),
      attachDemoTab(fill('#pw', 'password', '***', 4, true), { tabId: 2 }),
    ]
    const summary = summarizeDemoSteps(tagged)
    expect(summary.multiTab).toBe(true)
    expect(summary.masked).toBe(1)
    expect(summary.lines[0]).toBe('1. [tab 1] navigate -> https://example.com/')
    expect(summary.lines[2]).toBe('3. [tab 2] navigate -> https://example.com/docs')
    expect(summary.tabs.map(tab => tab.tabId)).toEqual([1, 2])
    expect(demoTabLegend(summary)).toEqual([
      'tabs: 2 (each step is tagged with the tab it happened in)',
      'tab 1: https://example.com/',
      'tab 2: https://example.com/docs',
    ])
  })
})
