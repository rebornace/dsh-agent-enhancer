import styles from '../styles.module.css'

const USAGE_ATTR = 'data-agent-enhancer-usage'
const TITLE_RE = /Token\s*(?:用量|usage)/i
const TOTAL_RE = /\d[\d,]*\s*tok/i
const CACHE_RE = /缓存命中|Cache\s*hit|未缓存|Uncached|缓存读取|Cache\s*read/i

export interface UsageMeterLinkOptions {
  readonly open: () => void
  readonly label: () => string
}

function cls(value: string | undefined): string {
  return value ?? ''
}

function textOf(node: Element): string {
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function isContextCompositionPanel(dialog: HTMLElement): boolean {
  return dialog.querySelectorAll(':scope > dl > div').length === 3
}

function isTokenUsagePanel(dialog: HTMLElement): boolean {
  if (isContextCompositionPanel(dialog)) return false
  const text = textOf(dialog)
  if (!TITLE_RE.test(text)) return false
  return TOTAL_RE.test(text) || CACHE_RE.test(text)
}

/** Official Token 用量 popover opened from the composer dock (not System/Tools/Messages). */
export function findOpenTokenUsagePanel(): HTMLElement | null {
  const dock = document.querySelector('[data-composer-dock]')
  if (!(dock instanceof HTMLElement)) return null
  const triggers = dock.querySelectorAll('button[aria-haspopup="dialog"][aria-expanded="true"]')
  if (triggers.length === 0) return null
  const dialogs = document.querySelectorAll<HTMLElement>('body > [role="dialog"]')
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index]
    if (dialog === undefined) continue
    if (isTokenUsagePanel(dialog)) return dialog
  }
  return null
}

/**
 * The highlighted title row: "Token 用量" + total tok.
 * Prefer the smallest node that still carries both the title and the total.
 */
export function findTokenUsageTitleRow(panel: HTMLElement): HTMLElement | null {
  const candidates: HTMLElement[] = []
  for (const node of panel.querySelectorAll('*')) {
    if (!(node instanceof HTMLElement)) continue
    if (node === panel) continue
    const text = textOf(node)
    if (!TITLE_RE.test(text) || !TOTAL_RE.test(text)) continue
    candidates.push(node)
  }
  if (candidates.length === 0) return null
  candidates.sort((left, right) => left.querySelectorAll('*').length - right.querySelectorAll('*').length)
  return candidates[0] ?? null
}

function enhanceTitleRow(row: HTMLElement, options: UsageMeterLinkOptions): void {
  if (row.getAttribute(USAGE_ATTR) === '1') return
  row.setAttribute(USAGE_ATTR, '1')
  row.classList.add(cls(styles.usageMeterTitleRow))
  row.tabIndex = 0
  row.setAttribute('role', 'button')
  row.setAttribute('aria-label', options.label())
  if (!row.querySelector('[data-agent-enhancer-usage-chevron]')) {
    const chevron = document.createElement('span')
    chevron.dataset.agentEnhancerUsageChevron = '1'
    chevron.className = cls(styles.usageMeterLinkChevron)
    chevron.setAttribute('aria-hidden', 'true')
    chevron.textContent = '›'
    row.append(chevron)
  }

  const open = () => { options.open() }
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
}

/**
 * Wire the official Token 用量 title row to open the plugin bill in the right sidebar.
 */
export function installUsageMeterLink(options: UsageMeterLinkOptions): () => void {
  const scan = () => {
    const panel = findOpenTokenUsagePanel()
    if (panel === null) return
    const title = findTokenUsageTitleRow(panel)
    if (title !== null) enhanceTitleRow(title, options)
  }
  const observer = new MutationObserver(scan)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
  scan()
  return () => {
    observer.disconnect()
  }
}
