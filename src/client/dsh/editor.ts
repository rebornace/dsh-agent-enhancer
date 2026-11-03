import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { DraftWriter } from '../prompt/types.ts'
import { detectOffset, replaceAroundOccurrences } from './structured.ts'

interface SelectionOffsets {
  readonly start: number
  readonly end: number
}

const BLOCK_ELEMENTS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL'])

function block(node: Node): boolean {
  return node.nodeType === Node.ELEMENT_NODE && BLOCK_ELEMENTS.has((node as Element).tagName)
}

function projectedText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') return '\n'
  let text = ''
  let previous: ChildNode | undefined
  for (const child of node.childNodes) {
    if (previous !== undefined && block(previous) && block(child)) text += '\n'
    text += projectedText(child)
    previous = child
  }
  return text
}

function pointAt(node: Node, offset: number): { node: Node; offset: number } {
  if (node.nodeType === Node.TEXT_NODE) {
    return { node, offset: Math.max(0, Math.min(offset, node.textContent?.length ?? 0)) }
  }
  if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') {
    const parent = node.parentNode!
    return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, node) + (offset > 0 ? 1 : 0) }
  }
  if (node.childNodes.length === 0) return { node, offset: 0 }
  let remaining = Math.max(0, offset)
  let previous: ChildNode | undefined
  for (const child of node.childNodes) {
    if (previous !== undefined && block(previous) && block(child)) {
      if (remaining === 0) return pointAt(previous, projectedText(previous).length)
      remaining -= 1
      if (remaining === 0) return pointAt(child, 0)
    }
    const length = projectedText(child).length
    if (remaining <= length) return pointAt(child, remaining)
    remaining -= length
    previous = child
  }
  return { node, offset: node.childNodes.length }
}

function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  const range = root.ownerDocument.createRange()
  range.selectNodeContents(root)
  range.setEnd(node, offset)
  return projectedText(range.cloneContents()).length
}

export function readSelection(root: HTMLElement): SelectionOffsets | null {
  const selection = root.ownerDocument.getSelection()
  const anchor = selection?.anchorNode
  const focus = selection?.focusNode
  if (selection?.rangeCount !== 1 || anchor == null || focus == null ||
    !root.contains(anchor) || !root.contains(focus)) return null
  const anchorOffset = offsetOf(root, anchor, selection.anchorOffset)
  const focusOffset = offsetOf(root, focus, selection.focusOffset)
  return { start: Math.min(anchorOffset, focusOffset), end: Math.max(anchorOffset, focusOffset) }
}

export function restoreSelection(root: HTMLElement, selection: SelectionOffsets): void {
  root.focus({ preventScroll: true })
  const start = pointAt(root, selection.start)
  const end = pointAt(root, selection.end)
  const range = root.ownerDocument.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  const native = root.ownerDocument.getSelection()
  native?.removeAllRanges()
  native?.addRange(range)
}

export function lineBoundary(text: string, caret: number): { first: boolean; last: boolean } {
  return {
    first: text.lastIndexOf('\n', Math.max(0, caret - 1)) < 0,
    last: text.indexOf('\n', caret) < 0,
  }
}

export function isAtFirstLine(root: HTMLElement): boolean {
  const selection = readSelection(root)
  return selection !== null && lineBoundary(projectedText(root), selection.start).first
}

export function isAtLastLine(root: HTMLElement): boolean {
  const selection = readSelection(root)
  return selection !== null && lineBoundary(projectedText(root), selection.end).last
}

export function isComposing(event: KeyboardEvent, root: HTMLElement): boolean {
  return event.isComposing || event.keyCode === 229 || root.hasAttribute('data-composer-composing')
}

export function officialMenuOpen(document: Document): boolean {
  return document.querySelector('[role="menu"], [role="listbox"]') !== null
}

export function publicWriter(root: HTMLElement, actions: InputActions): DraftWriter {
  return {
    replace(text, selection, segments, source) {
      if (selection.draftRev !== actions.captureInsertion().draftRev) return false
      if (selection.structured === true) {
        return segments !== undefined && selection.occurrences !== undefined && source !== undefined &&
          replaceAroundOccurrences(actions, source, selection.occurrences, segments)
      }
      const occurrences = selection.occurrences ?? []
      return actions.insertText(text, {
        ...selection,
        start: detectOffset(selection.start, occurrences),
        end: detectOffset(selection.end, occurrences),
      })
    },
    setDraft(text, caret) {
      actions.setDraft(text)
      actions.persistDraft()
      root.focus({ preventScroll: true })
      restoreSelection(root, { start: caret, end: caret })
    },
  }
}
