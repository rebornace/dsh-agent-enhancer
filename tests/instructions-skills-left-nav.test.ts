import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  createSkillsSectionGate,
  installInstructionsSkillsLeftNav,
  skillsLeftNavPanellistSupported,
} from '../src/client/instructions-skills/left-nav.ts'

type SlotRegisterSpec = {
  readonly name: string
  readonly key?: string
  readonly id?: string
}

function createSlotsHarness() {
  const registrations: SlotRegisterSpec[] = []
  const teardowns: Array<() => void> = []
  let panellistProbe: (() => unknown) | undefined

  const slots = {
    inject(name: string, callback: () => unknown) {
      if (name === 'sidebar.panellist') {
        panellistProbe = callback
      }
      return () => {}
    },
    register(spec: SlotRegisterSpec, _component: unknown) {
      registrations.push(spec)
      const off = () => {
        const index = registrations.findIndex(row =>
          row.name === spec.name && row.key === spec.key && row.id === spec.id)
        if (index >= 0) registrations.splice(index, 1)
      }
      teardowns.push(off)
      return off
    },
    runPanellistProbe() {
      if (panellistProbe === undefined) throw new Error('panellist inject was not installed')
      return panellistProbe()
    },
    registrations() {
      return registrations
    },
    teardownCount() {
      return teardowns.length
    },
  }

  return { slots, runPanellistProbe: () => slots.runPanellistProbe() }
}

function mockCtx(slots: ReturnType<typeof createSlotsHarness>['slots']): Context {
  return {
    slots,
    inject: vi.fn(() => ({ dispose: vi.fn() })),
  } as unknown as Context
}

const t = (key: string) => key

describe('createSkillsSectionGate', () => {
  it('does not register until markSupported and wanted are both true', () => {
    const off = vi.fn()
    const register = vi.fn(() => off)
    const gate = createSkillsSectionGate(register)
    gate.setWanted(true)
    expect(register).not.toHaveBeenCalled()
    gate.markSupported()
    expect(register).toHaveBeenCalledTimes(1)
    gate.setWanted(false)
    expect(off).toHaveBeenCalled()
  })
})

describe('installInstructionsSkillsLeftNav', () => {
  it('does not register main or panellist before the host panellist probe', () => {
    const harness = createSlotsHarness()
    const nav = installInstructionsSkillsLeftNav(mockCtx(harness.slots), {
      enabled: () => true,
      t,
      remote: () => ({ agentEnhancer: {} }),
      sidebarRight: () => undefined,
    })
    expect(harness.slots.registrations()).toEqual([])
    nav.dispose()
  })

  it('registers main and panellist after probe when enabled', () => {
    const harness = createSlotsHarness()
    const nav = installInstructionsSkillsLeftNav(mockCtx(harness.slots), {
      enabled: () => true,
      t,
      remote: () => ({ agentEnhancer: {} }),
      sidebarRight: () => undefined,
    })
    harness.runPanellistProbe()
    expect(skillsLeftNavPanellistSupported()).toBe(true)
    const names = harness.slots.registrations().map((row: SlotRegisterSpec) => row.name).sort()
    expect(names).toEqual(['main', 'sidebar.panellist'])
    nav.dispose()
    expect(harness.slots.registrations()).toEqual([])
    expect(skillsLeftNavPanellistSupported()).toBe(false)
  })

  it('tears down registrations when enabled becomes false', () => {
    const harness = createSlotsHarness()
    let enabled = true
    const nav = installInstructionsSkillsLeftNav(mockCtx(harness.slots), {
      enabled: () => enabled,
      t,
      remote: () => ({ agentEnhancer: {} }),
      sidebarRight: () => undefined,
    })
    harness.runPanellistProbe()
    expect(harness.slots.registrations()).toHaveLength(2)
    enabled = false
    nav.synchronize()
    expect(harness.slots.registrations()).toEqual([])
    nav.dispose()
  })

  it('dispose retires gate and clears panellist support flag', () => {
    const harness = createSlotsHarness()
    const nav = installInstructionsSkillsLeftNav(mockCtx(harness.slots), {
      enabled: () => true,
      t,
      remote: () => ({ agentEnhancer: {} }),
      sidebarRight: () => undefined,
    })
    harness.runPanellistProbe()
    nav.dispose()
    expect(harness.slots.registrations()).toEqual([])
    expect(skillsLeftNavPanellistSupported()).toBe(false)
  })
})
