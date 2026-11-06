interface XtermLike {
  getSelection(): string
  hasSelection(): boolean
}

function isXtermLike(value: unknown): value is XtermLike {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.getSelection === 'function'
    && typeof candidate.hasSelection === 'function'
}

function fiberKeyOf(element: Element): string | undefined {
  return Object.keys(element).find(key => (
    key.startsWith('__reactFiber$')
    || key.startsWith('__reactInternalInstance$')
  ))
}

function valuesOf(value: unknown, into: unknown[], depth: number): void {
  if (value === null || value === undefined || depth < 0) return
  if (typeof value !== 'object') return
  if (into.includes(value)) return
  into.push(value)
  if (Array.isArray(value)) {
    for (const entry of value) valuesOf(entry, into, depth - 1)
    return
  }
  const record = value as Record<string, unknown>
  for (const key of ['current', 'stateNode', 'memoizedState', 'memoizedProps', 'pendingProps', 'return', 'child', 'sibling']) {
    if (key in record) valuesOf(record[key], into, depth - 1)
  }
  // Hooks linked list on function components.
  if ('memoizedState' in record && record.memoizedState !== null && typeof record.memoizedState === 'object') {
    let hook: { next?: unknown; memoizedState?: unknown } | null = record.memoizedState as {
      next?: unknown
      memoizedState?: unknown
    }
    let guard = 0
    while (hook !== null && guard < 40) {
      valuesOf(hook.memoizedState, into, depth - 1)
      hook = (hook.next ?? null) as typeof hook
      guard += 1
    }
  }
}

/**
 * Locate the live xterm Terminal for a sidebar terminal DOM node.
 * Official UI keeps the instance in a React ref with no public API.
 */
export function findXtermNear(start: Element): XtermLike | null {
  const root = start.closest('[data-sidebar-terminal]') ?? start
  const queue: Element[] = [root, ...root.querySelectorAll('.xterm, .terminal')]
  const seen: unknown[] = []
  for (const node of queue) {
    const key = fiberKeyOf(node)
    if (key === undefined) continue
    valuesOf(Reflect.get(node, key), seen, 6)
  }
  for (const value of seen) {
    if (!isXtermLike(value)) continue
    try {
      if (value.hasSelection() || value.getSelection().trim() !== '') return value
    } catch {
      return value
    }
  }
  for (const value of seen) {
    if (isXtermLike(value)) return value
  }
  return null
}

export function readTerminalSelection(start: Element): string | null {
  const terminal = findXtermNear(start)
  if (terminal === null) return null
  try {
    if (!terminal.hasSelection()) return null
    const text = terminal.getSelection().replace(/\r\n?/gu, '\n').trim()
    return text === '' ? null : text
  } catch {
    return null
  }
}
