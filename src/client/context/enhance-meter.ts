import type { ContextInspectCategory } from '../../host/context-inspect.ts'
import styles from '../styles.module.css'

const CATEGORIES: readonly ContextInspectCategory[] = ['system', 'tools', 'messages']
const ENHANCED_ATTR = 'data-agent-enhancer-context'
const ROW_ATTR = 'data-agent-enhancer-context-row'

export interface ContextMeterEnhanceOptions {
  readonly enabled: () => boolean
  readonly sessionId: () => string | undefined
  readonly open: (category: ContextInspectCategory) => void
  readonly t: (key: string, params?: Record<string, string | number>) => string
}

function cls(value: string | undefined): string {
  return value ?? ''
}

function findOpenMeterPanel(): HTMLElement | null {
  const dock = document.querySelector('[data-composer-dock]')
  if (!(dock instanceof HTMLElement)) return null
  const trigger = dock.querySelector('button[aria-haspopup="dialog"][aria-expanded="true"]')
  if (!(trigger instanceof HTMLElement)) return null
  const dialogs = document.querySelectorAll<HTMLElement>('body > [role="dialog"]')
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index]
    if (dialog === undefined) continue
    const rows = dialog.querySelectorAll(':scope > dl > div')
    if (rows.length === 3) return dialog
  }
  return null
}

function enhancePanel(panel: HTMLElement, options: ContextMeterEnhanceOptions): void {
  if (panel.getAttribute(ENHANCED_ATTR) === '1') return
  panel.setAttribute(ENHANCED_ATTR, '1')
  const rows = [...panel.querySelectorAll(':scope > dl > div')]
  if (rows.length !== 3) return

  rows.forEach((row, index) => {
    if (!(row instanceof HTMLElement)) return
    const category = CATEGORIES[index]
    if (category === undefined) return
    row.setAttribute(ROW_ATTR, category)
    row.classList.add(cls(styles.contextMeterRow))
    row.tabIndex = 0
    row.setAttribute('role', 'button')
    row.setAttribute('aria-label', String(options.t('contextInspectOpenCategory', {
      category: String(options.t(`contextInspectCategory_${category}`)),
    })))
    if (!row.querySelector('[data-agent-enhancer-chevron]')) {
      const chevron = document.createElement('span')
      chevron.dataset.agentEnhancerChevron = '1'
      chevron.className = cls(styles.contextMeterChevron)
      chevron.setAttribute('aria-hidden', 'true')
      chevron.textContent = '›'
      row.append(chevron)
    }

    const open = () => {
      if (!options.enabled()) return
      const sessionId = options.sessionId()
      if (sessionId === undefined || sessionId === '') return
      options.open(category)
    }

    row.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      open()
    })
    row.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      event.stopPropagation()
      open()
    })
  })
}

export function installContextMeterEnhance(options: ContextMeterEnhanceOptions): () => void {
  const scan = () => {
    const panel = findOpenMeterPanel()
    if (panel !== null) enhancePanel(panel, options)
  }
  const observer = new MutationObserver(scan)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
  scan()
  return () => {
    observer.disconnect()
  }
}
