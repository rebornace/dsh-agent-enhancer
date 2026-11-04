import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useEffect, useSyncExternalStore } from 'react'
import styles from '../styles.module.css'
import type { RollbackController } from './controller.ts'
import { rememberRollbackInputActions } from './input-actions-cache.ts'
import { rollbackModalCopy, RollbackPreview } from './preview.tsx'
import { confirmBlocked, scopeLabel } from './scope.ts'
import type { RollbackModalSurface } from './types.ts'

export interface RollbackModalHostProps {
  readonly rollback: RollbackController
  readonly t: TranslateNS<'agent-enhancer'>
  readonly inputActions: InputActions
  readonly useSession?: (selector: (state: { running: boolean }) => unknown) => unknown
  readonly onOpenTimeline?: (turn: number) => void
  /**
   * Which opens this host should present. Composer overlay owns message-row
   * restores; the timeline tab owns right-pane restores so the dialog still
   * appears when the overlay subscriber is not the active surface.
   */
  readonly surface?: RollbackModalSurface
  readonly sessionId?: SessionId
}

/** Stable session-level modal so surface replacement cannot unmount an in-flight restore. */
export function RollbackModalHost(props: RollbackModalHostProps) {
  const surface = props.surface ?? 'composer'
  const snapshot = useSyncExternalStore(props.rollback.subscribe, props.rollback.getSnapshot)
  const active = snapshot.active
  const owned = active !== null && active.surface === surface
  const running = props.useSession === undefined
    ? false
    : props.useSession(state => state.running) as boolean
  const trackedFiles = active?.preview?.files.length ?? 0
  const undoScope = scopeLabel(active?.scope ?? active?.preview?.scope)
  const conversationBlocked = active?.preview === undefined
    || confirmBlocked(active.preview.unavailable, active.preview.conflicts, 'conversation', trackedFiles)
  const filesBlocked = active?.preview === undefined
    || confirmBlocked(active.preview.unavailable, active.preview.conflicts, 'conversation-and-files', trackedFiles)
  const undoBlocked = active?.preview === undefined
    || confirmBlocked(active.preview.unavailable, active.preview.conflicts, undoScope, trackedFiles)
  const alreadyRestored = owned && active?.operation === 'rollback'
    && active.preview?.unavailable.includes('already-restored') === true
  const coveredByEarlier = owned && active?.operation === 'rollback'
    && active.preview?.unavailable.includes('covered-by-earlier-restore') === true
  const modal = !owned || active === null ? null : rollbackModalCopy(
    active.operation,
    props.t,
    active.turn,
    active.operation === 'undo' ? undoScope : undefined,
    alreadyRestored,
    coveredByEarlier,
  )
  const ready = active?.status === 'ready'
  const executing = active?.status === 'executing'
  const errored = active?.status === 'error'

  useEffect(() => {
    rememberRollbackInputActions(props.sessionId, props.inputActions)
  }, [props.sessionId, props.inputActions])

  useEffect(() => props.rollback.registerSurface(surface), [props.rollback, surface])

  useEffect(() => {
    if (!owned) return
    props.rollback.notifySessionRunning(running)
  }, [props.rollback, running, owned])

  useEffect(() => {
    if (!owned || active === null) return
    const dialog = document.querySelector(`.${styles.rollbackDialog}`)
    // Prefer the official mask marker; fall back to the first sibling only when it
    // is not the dialog itself (so we never swallow clicks on confirm buttons).
    const parent = dialog?.parentElement
    const byAria = parent?.querySelector('[aria-hidden="true"]')
    const first = parent?.firstElementChild
    const mask = byAria instanceof HTMLElement ? byAria
      : first instanceof HTMLElement && first !== dialog ? first
        : null
    if (mask === null) return
    // Official Modal always wires mask onClick→onClose; stop it before React handles the event.
    const stop = (event: Event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click'] as const) {
      mask.addEventListener(type, stop, true)
    }
    return () => {
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click'] as const) {
        mask.removeEventListener(type, stop, true)
      }
    }
  }, [active, owned])

  if (!snapshot.enabled || !owned || active === null || modal === null) return null

  const requestClose = () => {
    if (active.status === 'executing') return
    props.rollback.close(active.turn)
  }

  const runConfirm = (scope: 'conversation' | 'conversation-and-files') => {
    if (active.status !== 'ready' || executing) return
    void props.rollback.confirm(props.inputActions, scope)
  }

  const runUndoInstead = () => {
    if (active.status === 'executing') return
    // Undo the live tip — browsing a later rolled-back checkpoint must not target that turn.
    const tipTurn = active.preview?.tipTurn ?? active.turn
    props.rollback.open(tipTurn, 'undo', { surface: active.surface })
  }

  const runRetry = () => {
    if (active.status !== 'error') return
    props.rollback.open(active.turn, active.operation, { surface: active.surface })
  }

  return <Modal
    open
    title={modal.title}
    description={modal.description}
    closeLabel={props.t('rollbackClose')}
    className={styles.rollbackDialog}
    contentClassName={styles.rollbackContent}
    onClose={requestClose}
    footer={<>
      <Button type="button" disabled={executing}
        onClick={requestClose}>{props.t('rollbackCancel')}</Button>
      {errored ? <Button type="button" data-modal-autofocus onClick={runRetry}>
        {props.t('rollbackRetry')}
      </Button> : active.operation === 'undo' ? <Button type="button" data-modal-autofocus
        disabled={!ready || undoBlocked || executing}
        onClick={() => { runConfirm(undoScope) }}>
        {executing ? modal.executing : modal.confirm}
      </Button> : executing ? <Button type="button" disabled>
        {active.scope === 'conversation' ? modal.executingConversation : modal.executing}
      </Button> : coveredByEarlier ? <Button type="button" data-modal-autofocus disabled={!ready}
        onClick={runUndoInstead}>{props.t('rollbackUndoAction')}</Button>
        : <>
        {alreadyRestored
          ? <Button type="button" disabled={!ready}
            onClick={runUndoInstead}>{props.t('rollbackUndoAction')}</Button>
          : null}
        <Button type="button" data-modal-autofocus disabled={!ready || conversationBlocked}
          onClick={() => { runConfirm('conversation') }}>
          {modal.confirmConversation}
        </Button>
        <Button type="button" disabled={!ready || filesBlocked}
          onClick={() => { runConfirm('conversation-and-files') }}>
          {modal.confirm}
        </Button>
      </>}
    </>}
  ><RollbackPreview active={active} t={props.t} onOpenTimeline={props.onOpenTimeline} /></Modal>
}
