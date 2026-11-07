import type { Context } from '@deepseek-ai/cordis'
import { createElement, useSyncExternalStore } from 'react'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { FileEditNavigator } from '../file-edit/open-tab.ts'
import { InstructionsSkillsGuideIcon } from './guide-icon.tsx'
import { SKILLS_PANEL_ID } from './kind.ts'
import {
  getSkillsNavHasUpdates,
  resetSkillsNavHasUpdates,
  subscribeSkillsNavHasUpdates,
} from './nav-update-hints.ts'
import { InstructionsSkillsMainPanel } from './tab.tsx'
import styles from '../styles.module.css'
import './slot-types.ts'

export { SKILLS_PANEL_ID }

export interface InstallInstructionsSkillsLeftNavOptions {
  readonly enabled: () => boolean
  readonly t: TranslateNS<'agent-enhancer'>
  readonly remote: () => { readonly agentEnhancer: object } | undefined
  readonly sidebarRight: () => FileEditNavigator | undefined
}

function createSectionGate(register: () => () => void) {
  let ready = false
  let wanted = false
  let removed = false
  let dispose: (() => void) | null = null
  const apply = () => {
    if (!ready) return
    const shouldShow = wanted && !removed
    if (shouldShow && dispose === null) {
      dispose = register()
      return
    }
    if (!shouldShow && dispose !== null) {
      const stop = dispose
      dispose = null
      stop()
    }
  }
  return {
    markSupported: () => {
      ready = true
      apply()
    },
    setWanted: (visible: boolean) => {
      wanted = visible
      apply()
    },
    retire: () => {
      removed = true
      apply()
    },
  }
}

/**
 * Register Skills into `sidebar.panellist` + `main` when the host exposes the seat.
 * Pattern mirrors dshmarket `createSectionGate` (probe inject before register).
 */
let panellistSeatProbed = false
const panellistSeatListeners = new Set<() => void>()

function setPanellistSeatProbed(probed: boolean) {
  if (panellistSeatProbed === probed) return
  panellistSeatProbed = probed
  for (const listener of panellistSeatListeners) listener()
}

/** Whether the host invoked the `sidebar.panellist` inject probe (seat declared). */
export function skillsLeftNavPanellistSupported(): boolean {
  return panellistSeatProbed
}

export function subscribeSkillsLeftNavPanellist(listener: () => void): () => void {
  panellistSeatListeners.add(listener)
  return () => {
    panellistSeatListeners.delete(listener)
  }
}

export interface InstructionsSkillsLeftNavHandle {
  readonly dispose: () => void
  readonly synchronize: () => void
  readonly panellistSupported: () => boolean
}

/** @internal Exported for unit tests of the market-style gate. */
export function createSkillsSectionGate(register: () => () => void) {
  return createSectionGate(register)
}

function SkillsPanellistIcon(
  props: PropsRuntime<'sidebar.panellist', typeof SKILLS_PANEL_ID>,
) {
  const hasUpdates = useSyncExternalStore(
    subscribeSkillsNavHasUpdates,
    getSkillsNavHasUpdates,
    getSkillsNavHasUpdates,
  )
  return createElement(
    'span',
    { className: styles.instructionsSkillsNavIconWrap },
    createElement(InstructionsSkillsGuideIcon, { size: props.size ?? 16 }),
    hasUpdates
      ? createElement('span', {
        className: styles.instructionsSkillsNavDot,
        'aria-hidden': true,
      })
      : null,
  )
}

export function installInstructionsSkillsLeftNav(
  ctx: Context,
  options: InstallInstructionsSkillsLeftNavOptions,
): InstructionsSkillsLeftNavHandle {
  const disposers: Array<() => void> = []
  let layout: import('@deepseek-ai/dsh-client-ui-layout/client').ILayout | undefined

  const gate = createSectionGate(() => {
    const offPanel = ctx.slots.register({
      name: 'main',
      key: SKILLS_PANEL_ID,
      locale: 'agent-enhancer',
      inject: () => ({ t: options.t }),
    }, props => createElement(InstructionsSkillsMainPanel, {
      ...props,
      remote: options.remote,
      sidebarRight: options.sidebarRight,
      t: options.t,
      onLeaveForPreview: () => {
        layout?.selectPanel(null)
      },
    }))
    const offRow = ctx.slots.register({
      name: 'sidebar.panellist',
      id: SKILLS_PANEL_ID,
      order: 2,
      label: () => options.t('instructionsSkills'),
      locale: 'agent-enhancer',
    }, SkillsPanellistIcon)
    return () => {
      if (layout?.panelInfo.getSnapshot().activePanelId === SKILLS_PANEL_ID) {
        layout.selectPanel(null)
      }
      if (typeof offRow === 'function') offRow()
      if (typeof offPanel === 'function') offPanel()
    }
  })

  disposers.push(ctx.slots.inject('sidebar.panellist', () => {
    setPanellistSeatProbed(true)
    gate.markSupported()
    return () => {}
  }))

  const layoutFiber = ctx.inject(['layout'], scoped => {
    layout = scoped.layout
  })
  disposers.push(() => { void layoutFiber.dispose() })

  const synchronize = () => {
    gate.setWanted(options.enabled())
  }
  synchronize()

  const dispose = () => {
    gate.retire()
    while (disposers.length > 0) disposers.pop()?.()
    setPanellistSeatProbed(false)
    resetSkillsNavHasUpdates()
  }

  return {
    dispose,
    synchronize,
    panellistSupported: skillsLeftNavPanellistSupported,
  }
}
