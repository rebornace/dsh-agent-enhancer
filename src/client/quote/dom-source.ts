/** Elements that already own quote UX or must never feed the DOM host. */
const EXCLUDED = [
  '[data-composer-input]',
  '[data-composer-card]',
  '[data-text-interaction-surface]',
  '[data-text-interaction-source]',
  '[data-sidebar-terminal]',
  '[data-agent-enhancer-monaco]',
  '[data-agent-enhancer-quote-portal]',
  '[role="tree"]',
  '[role="treeitem"]',
  'button',
  'textarea',
  'input',
  '[contenteditable="true"]',
].join(', ')

/**
 * Official document-preview / code-block markers (workspace + extra-folder
 * files open through the same preview).
 */
const PREVIEW_MARKERS = [
  '[data-textpreview-plain]',
  '[data-textpreview-line]',
  '[data-code-block-content]',
  '[data-document-preview]',
].join(', ')

const SIDEBAR_PANE = [
  '[data-slot="sidebar.right.pane.tab"]',
  '[data-sidebar-right-pane]',
].join(', ')

export function elementOfNode(node: Node | null): Element | null {
  if (node === null) return null
  return node instanceof Element ? node : node.parentElement
}

/** True when a DOM selection should open the external quote chip. */
export function isDomQuoteSource(node: Node | null): boolean {
  const el = elementOfNode(node)
  if (el === null) return false
  if (el.closest(EXCLUDED) !== null) return false
  if (el.closest(PREVIEW_MARKERS) !== null) return true
  // Markdown preview often lacks textpreview attrs — allow other right-pane body text.
  return el.closest(SIDEBAR_PANE) !== null
}
