import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input, MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PromptInput, PromptSearchState, Coordinator } from '../prompt/coordinator.ts'
import type { PromptSession } from '../prompt/session.ts'
import type { PromptKey, KeyContext, PromptEntry } from '../prompt/types.ts'
import styles from '../styles.module.css'
import { latestCompletedTurn, sentPrompts } from './conversation.ts'
import { isComposing, lineBoundary, officialMenuOpen, publicWriter, readSelection } from './editor.ts'
import { CoexistenceHints } from './hints.tsx'
import type { OverlapHintStore } from './plugin-hints.ts'

export type AgentOverlayProps = PropsRuntime<'conversation.input.overlay'> & {
  readonly session: PromptSession
  readonly hints?: OverlapHintStore
  readonly t: TranslateNS<'agent-enhancer'>
}

interface ActivePrompt {
  sync(): void
  refreshHistory(): void
  dispose(): void
}

function keyOf(event: KeyboardEvent): PromptKey | null {
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === 'KeyR') return 'search'
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyR') return 'search'
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  switch (event.key) {
    case 'ArrowUp': return 'up'
    case 'ArrowDown': return 'down'
    case 'Tab': return event.shiftKey ? null : 'tab'
    case 'Enter': return event.shiftKey ? null : 'enter'
    case 'Escape': return 'escape'
    default: return null
  }
}

const dialogKeyContext: KeyContext = {
  composing: false,
  systemLayerOpen: false,
  officialMenuOpen: false,
  atFirstLine: true,
  atLastLine: true,
}

export function AgentOverlay(props: AgentOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<ActivePrompt | null>(null)
  const coordinatorRef = useRef<Coordinator | null>(null)
  const [search, setSearch] = useState<PromptSearchState | null>(null)
  const [prediction, setPrediction] = useState<string | null>(null)
  const input = props.useInput(state => state)
  const session = props.useSession(state => state)
  const chat = props.useConversation(snapshot => snapshot.views.get('chat')) as ChatSnapshot | undefined
  const latestRef = useRef({ input, session, chat })
  latestRef.current = { input, session, chat }

  useEffect(() => {
    const container = containerRef.current
    const root = container?.closest('[data-composer-card]')?.querySelector<HTMLElement>('[data-composer-input]')
    if (container == null || root == null) return
    const coordinator = props.session.coordinator
    const detach = props.session.attach(publicWriter(root, props.inputActions))
    coordinatorRef.current = coordinator
    const unsubscribe = coordinator.subscribe(() => {
      setSearch(coordinator.searchSnapshot())
      setPrediction(coordinator.predictionSnapshot())
    })
    let unregisterHistory = () => {}
    const refreshHistory = () => {
      unregisterHistory()
      unregisterHistory = coordinator.registerHistory({
        load: requested => requested === props.sessionId ? sentPrompts(latestRef.current.chat) : [],
      })
    }
    let selection = { start: latestRef.current.input.draft.length, end: latestRef.current.input.draft.length }
    const sync = () => {
      selection = readSelection(root) ?? selection
      const current = latestRef.current
      const facts: PromptInput = {
        sessionId: props.sessionId,
        draft: current.input.draft,
        draftRev: current.input.draftRev,
        selection,
        occurrences: current.input.occurrences,
        running: current.session.running,
      }
      const latest = latestCompletedTurn(current.chat, current.session)
      props.session.sync(facts, latest === null ? [] : [latest], current.input.occurrences.length > 0)
    }
    const externalMenuOpen = () => Array.from(root.ownerDocument.querySelectorAll('[role="menu"], [role="listbox"]'))
      .some(menu => !container.contains(menu))
    const cancelPredictionOnOfficialMenu = () => {
      if (externalMenuOpen()) props.session.cancelPrediction()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      queueMicrotask(cancelPredictionOnOfficialMenu)
      if (event.defaultPrevented) return
      const key = keyOf(event)
      if (key === null) return
      sync()
      if (latestRef.current.input.occurrences.length > 0 && (key === 'up' || key === 'down' || key === 'search')) return
      const context = {
        composing: isComposing(event, root),
        systemLayerOpen: root.ownerDocument.querySelector('[role="dialog"], [role="alertdialog"]') !== null,
        officialMenuOpen: officialMenuOpen(root.ownerDocument),
        atFirstLine: lineBoundary(latestRef.current.input.draft, selection.start).first,
        atLastLine: lineBoundary(latestRef.current.input.draft, selection.end).last,
      }
      if (context.officialMenuOpen) props.session.cancelPrediction()
      const handled = props.session.handleKey(key, context)
      if (handled) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    const onInput = () => {
      props.session.cancelPrediction()
      sync()
    }
    const onOfficialMenuPointer = (event: Event) => {
      if (container.contains(event.target as Node)) return
      if (!externalMenuOpen()) return
      props.session.cancelPrediction()
      props.session.handleKey('escape', { ...dialogKeyContext, officialMenuOpen: true })
    }
    root.addEventListener('keydown', onKeyDown)
    root.addEventListener('input', onInput)
    root.addEventListener('compositionstart', sync)
    root.addEventListener('compositionend', sync)
    root.ownerDocument.addEventListener('selectionchange', sync)
    root.ownerDocument.addEventListener('pointerdown', onOfficialMenuPointer)
    root.ownerDocument.addEventListener('click', onOfficialMenuPointer)
    const active: ActivePrompt = {
      sync,
      refreshHistory,
      dispose() {
        root.removeEventListener('keydown', onKeyDown)
        root.removeEventListener('input', onInput)
        root.removeEventListener('compositionstart', sync)
        root.removeEventListener('compositionend', sync)
        root.ownerDocument.removeEventListener('selectionchange', sync)
        root.ownerDocument.removeEventListener('pointerdown', onOfficialMenuPointer)
        root.ownerDocument.removeEventListener('click', onOfficialMenuPointer)
        unregisterHistory()
        unsubscribe()
        detach()
      },
    }
    activeRef.current = active
    sync()
    return () => {
      active.dispose()
      if (activeRef.current === active) activeRef.current = null
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null
    }
  }, [props.inputActions, props.sessionId, props.session])

  useEffect(() => {
    activeRef.current?.refreshHistory()
  }, [chat, props.sessionId])

  useEffect(() => {
    activeRef.current?.sync()
  })

  const searchOpen = search !== null
  useEffect(() => {
    if (!searchOpen) return
    const container = containerRef.current
    const document = container?.ownerDocument
    if (container == null || document == null) return
    const onPointerDown = (event: PointerEvent) => {
      if (container.contains(event.target as Node)) return
      props.session.handleKey('escape', dialogKeyContext)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [searchOpen])

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    const key = keyOf(event.nativeEvent)
    if (key !== 'up' && key !== 'down' && key !== 'enter' && key !== 'escape') return
    if (key === 'enter' && (event.target as HTMLElement).closest('button') !== null) return
    const handled = props.session.handleKey(key, dialogKeyContext) ?? false
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  const acceptHistory = (entry: PromptEntry) => {
    if (search !== null) coordinatorRef.current?.acceptHistory(entry, search.original)
  }

  return <div ref={containerRef} data-agent-enhancer-overlay="">
    {props.hints === undefined ? null : <CoexistenceHints store={props.hints} t={props.t} />}
    {prediction === null ? null : (
      <div className={styles.prediction} data-agent-enhancer-prediction aria-live="polite">
        <span>{prediction}</span><kbd>Tab</kbd>
      </div>
    )}
    {search !== null && <MenuSurface
      className={styles.historyDialog}
      role="dialog"
      aria-label={props.t('historyTitle')}
      onKeyDown={onSearchKeyDown}
    >
      <div className={styles.historyHeader}>
        <span>{props.t('historyTitle')}</span>
        <Button type="button" size="sm" onClick={() => {
          props.session.handleKey('escape', dialogKeyContext)
        }}>{props.t('historyClose')}</Button>
      </div>
      <Input
        autoFocus
        aria-label={props.t('historySearch')}
        value={search.query}
        onChange={event => coordinatorRef.current?.updateSearch(event.target.value)}
      />
      <ul className={styles.historyResults} role="listbox" aria-label={props.t('historyResults')}>
        {search.entries.map(entry => <li
          className={styles.historyResult}
          key={entry.seq}
          role="option"
          aria-selected={entry.seq === search.selectedSeq}
          onMouseDown={event => { event.preventDefault() }}
          onClick={() => { acceptHistory(entry) }}
        >{entry.text}</li>)}
      </ul>
    </MenuSurface>}
  </div>
}
