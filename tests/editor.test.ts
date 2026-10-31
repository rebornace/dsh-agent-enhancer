// @vitest-environment jsdom
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isAtFirstLine, isAtLastLine, isComposing, lineBoundary, officialMenuOpen,
  publicWriter, readSelection, restoreSelection,
} from '../src/client/dsh/editor.ts'

function composer(html: string): HTMLElement {
  const root = document.createElement('div')
  root.dataset.composerInput = ''
  root.contentEditable = 'true'
  root.tabIndex = 0
  root.innerHTML = html
  document.body.append(root)
  return root
}

function select(root: HTMLElement, node: Node, offset: number): void {
  root.focus()
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

beforeEach(() => {
  document.body.replaceChildren()
  document.getSelection()?.removeAllRanges()
})

describe('composer DOM selection projection', () => {
  it('uses UTF-16 offsets and preserves Lexical paragraph and line-break newlines', () => {
    const root = composer('<p>ab😀</p><p>cd<br>ef</p>')
    const secondParagraph = root.children[1]!
    select(root, secondParagraph.firstChild!, 2)

    expect(readSelection(root)).toEqual({ start: 7, end: 7 })
    expect(isAtFirstLine(root)).toBe(false)
    expect(isAtLastLine(root)).toBe(false)

    restoreSelection(root, { start: 5, end: 5 })
    expect(readSelection(root)).toEqual({ start: 5, end: 5 })
    expect(document.activeElement).toBe(root)

    restoreSelection(root, { start: 1, end: 9 })
    expect(readSelection(root)).toEqual({ start: 1, end: 9 })
    expect(isAtFirstLine(root)).toBe(true)
    expect(isAtLastLine(root)).toBe(true)
  })

  it('returns no selection for another editor and derives logical line boundaries', () => {
    const root = composer('<p>one</p><p>two</p>')
    const other = composer('<p>other</p>')
    select(other, other.firstChild!.firstChild!, 1)
    expect(readSelection(root)).toBeNull()

    expect(lineBoundary('one\ntwo\nthree', 0)).toEqual({ first: true, last: false })
    expect(lineBoundary('one\ntwo\nthree', 4)).toEqual({ first: false, last: false })
    expect(lineBoundary('one\ntwo\nthree', 8)).toEqual({ first: false, last: true })
    select(root, root.children[1]!.firstChild!, 3)
    expect(isAtLastLine(root)).toBe(true)
  })
})

describe('keyboard guards', () => {
  it('recognizes IME composition from events, keyCode 229, and the root marker', () => {
    const root = composer('<p>text</p>')
    const composing = new KeyboardEvent('keydown', { key: 'ArrowUp', isComposing: true })
    const keyCode = new KeyboardEvent('keydown', { key: 'ArrowUp' })
    Object.defineProperty(keyCode, 'keyCode', { value: 229 })
    expect(isComposing(composing, root)).toBe(true)
    expect(isComposing(keyCode, root)).toBe(true)
    expect(isComposing(new KeyboardEvent('keydown'), root)).toBe(false)
    root.dataset.composerComposing = ''
    expect(isComposing(new KeyboardEvent('keydown'), root)).toBe(true)
  })

  it('leaves keys to an official menu or listbox', () => {
    expect(officialMenuOpen(document)).toBe(false)
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.append(menu)
    expect(officialMenuOpen(document)).toBe(true)
    menu.remove()
    const listbox = document.createElement('div')
    listbox.setAttribute('role', 'listbox')
    document.body.append(listbox)
    expect(officialMenuOpen(document)).toBe(true)
  })
})

describe('public InputActions writer', () => {
  it('passes the original guarded span to insertText and rejects stale revisions', () => {
    const root = composer('<p>text</p>')
    let draftRev = 7
    const captured = { start: 1, end: 2, draftRev: 7 }
    const insertText = vi.fn<(text: string, span: typeof captured) => boolean>(() => true)
    const actions = {
      captureInsertion: () => ({ ...captured, draftRev }),
      insertText,
    } as Pick<InputActions, 'captureInsertion' | 'insertText'> as InputActions
    const writer = publicWriter(root, actions)
    const guard = { sessionId: 's1' as SessionId, start: 4, end: 5, draftRev: 7 }

    expect(writer.replace('new', guard)).toBe(true)
    expect(insertText).toHaveBeenCalledWith('new', guard)
    draftRev = 8
    expect(writer.replace('stale', guard)).toBe(false)
    expect(insertText).toHaveBeenCalledTimes(1)
  })

  it('uses the guarded draft source instead of a stale DOM projection', () => {
    const root = composer('<p></p>')
    const insertText = vi.fn<(text: string, span: { start: number; end: number; draftRev: number }) => boolean>(() => true)
    const actions = {
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 7 }),
      insertText,
      persistDraft: vi.fn(),
    } as unknown as InputActions
    const selection = {
      sessionId: 's1' as SessionId,
      start: 0,
      end: 5,
      draftRev: 7,
      structured: true,
      occurrences: [{ occurrenceId: 7, source: 'file' as const, ref: 'x', offset: 1, length: 2, label: 'x', clipboardText: '@x' }],
    }

    expect(publicWriter(root, actions).replace('A@x C', selection, ['A', ' C'], 'a@x c')).toBe(true)
    expect(insertText.mock.calls).toEqual([
      [' C', { start: 2, end: 4, draftRev: 7 }],
      ['A', { start: 0, end: 1, draftRev: 7 }],
    ])
  })

  it('persists before restoring a UTF-16 caret without another public write', () => {
    const root = composer('<p>old</p>')
    const calls: string[] = []
    const actions = {
      setDraft: (text: string) => {
        calls.push(`set:${text}`)
        root.innerHTML = `<p>${text}</p>`
      },
      persistDraft: () => { calls.push('persist') },
    } as Pick<InputActions, 'setDraft' | 'persistDraft'> as InputActions

    publicWriter(root, actions).setDraft('a😀b', 4)
    expect(calls).toEqual(['set:a😀b', 'persist'])
    expect(readSelection(root)).toEqual({ start: 4, end: 4 })
    expect(document.activeElement).toBe(root)
  })
})
