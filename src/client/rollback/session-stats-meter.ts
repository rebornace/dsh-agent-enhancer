import styles from '../styles.module.css'

const CHECKPOINT_ATTR = 'data-agent-enhancer-checkpoint'
const TITLE_RE = /会话统计|Session\s*statistics|Session\s*stats/i
const STAT_RE = /TTFT|TPS|模型用时|工具调用|首\s*token|输出速度|tok\s*\/\s*s/i

export interface SessionStatsCheckpointLinkOptions {
  readonly enabled: () => boolean
  readonly sessionId: () => string | undefined
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
  const text = textOf(dialog)
  return /Token\s*(?:用量|usage)/i.test(text) && /\d[\d,]*\s*tok/i.test(text)
}

function isSessionStatsPanel(dialog: HTMLElement): boolean {
  if (isContextCompositionPanel(dialog) || isTokenUsagePanel(dialog)) return false
  const text = textOf(dialog)
  if (!TITLE_RE.test(text)) return false
  return STAT_RE.test(text)
}

/** Official 会话统计 popover opened from the composer turn/step pill. */
export function findOpenSessionStatsPanel(): HTMLElement | null {
  const dock = document.querySelector('[data-composer-dock]')
  if (!(dock instanceof HTMLElement)) return null
  const triggers = dock.querySelectorAll('button[aria-haspopup="dialog"][aria-expanded="true"]')
  if (triggers.length === 0) return null
  const dialogs = document.querySelectorAll<HTMLElement>('body > [role="dialog"]')
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index]
    if (dialog === undefined) continue
    if (isSessionStatsPanel(dialog)) return dialog
  }
  return null
}

/**
 * Title row for "会话统计" — prefer the smallest node that still carries the title.
 */
export function findSessionStatsTitleRow(panel: HTMLElement): HTMLElement | null {
  const candidates: HTMLElement[] = []
  for (const node of panel.querySelectorAll('*')) {
    if (!(node instanceof HTMLElement) || node === panel) continue
    const text = textOf(node)
    if (!TITLE_RE.test(text)) continue
    // Prefer the compact header, not the whole dialog body that also mentions stats.
    if (STAT_RE.test(text) && text.length > 40) continue
    candidates.push(node)
  }
  if (candidates.length === 0) return null
  candidates.sort((left, right) => left.querySelectorAll('*').length - right.querySelectorAll('*').length)
  return candidates[0] ?? null
}

function enhanceTitleRow(row: HTMLElement, options: SessionStatsCheckpointLinkOptions): void {
  if (row.getAttribute(CHECKPOINT_ATTR) === '1') return
  row.setAttribute(CHECKPOINT_ATTR, '1')
  row.classList.add(cls(styles.sessionStatsCheckpointRow))
  row.tabIndex = 0
  row.setAttribute('role', 'button')
  row.setAttribute('aria-label', options.label())
  if (!row.querySelector('[data-agent-enhancer-checkpoint-chevron]')) {
    const chevron = document.createElement('span')
    chevron.dataset.agentEnhancerCheckpointChevron = '1'
    chevron.className = cls(styles.sessionStatsCheckpointChevron)
    chevron.setAttribute('aria-hidden', 'true')
    chevron.textContent = '›'
    row.append(chevron)
  }

  const open = () => {
    if (!options.enabled()) return
    const sessionId = options.sessionId()
    if (sessionId === undefined || sessionId === '') return
    options.open()
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
}

/**
 * Wire the official 会话统计 title to open the checkpoint timeline — a stable
 * entry when per-message restore buttons are gone after a full rollback.
 */
export function installSessionStatsCheckpointLink(
  options: SessionStatsCheckpointLinkOptions,
): () => void {
  const scan = () => {
    const panel = findOpenSessionStatsPanel()
    if (panel === null) return
    const title = findSessionStatsTitleRow(panel)
    if (title !== null) enhanceTitleRow(title, options)
  }
  const observer = new MutationObserver(scan)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-expanded'],
  })
  scan()
  return () => {
    observer.disconnect()
  }
}
