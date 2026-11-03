import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useSyncExternalStore } from 'react'
import styles from '../styles.module.css'
import type { RollbackController } from './controller.ts'
import { rollbackModalCopy, RollbackPreview } from './preview.tsx'
import { confirmBlocked, scopeLabel } from './scope.ts'

export interface RollbackModalHostProps {
  readonly rollback: RollbackController
  readonly t: TranslateNS<'agent-enhancer'>
  readonly inputActions: InputActions
}

/** Stable session-level modal so surface replacement cannot unmount an in-flight restore. */
export function RollbackModalHost(props: RollbackModalHostProps) {
  const snapshot = useSyncExternalStore(props.rollback.subscribe, props.rollback.getSnapshot)
  const active = snapshot.active
  const trackedFiles = active?.preview?.files.length ?? 0
  const undoScope = scopeLabel(active?.scope ?? active?.preview?.scope)
  const conversationBlocked = active?.preview === undefined
    || confirmBlocked(active.preview.unavailable, active.preview.conflicts, 'conversation', trackedFiles)
  const filesBlocked = active?.preview === undefined
    || confirmBlocked(active.preview.unavailable, active.preview.conflicts, 'conversation-and-files', trackedFiles)
  const undoBlocked = active?.preview === undefined
    || confirmBlocked(active.preview.unavailable, active.preview.conflicts, undoScope, trackedFiles)
  const modal = active === null ? null : rollbackModalCopy(
    active.operation,
    props.t,
    active.turn,
    active.operation === 'undo' ? undoScope : undefined,
  )
  const ready = active?.status === 'ready'
  const executing = active?.status === 'executing'

  useEffect(() => {
    if (active === null) return
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
  }, [active])

  if (!snapshot.enabled || active === null || modal === null) return null

  const requestClose = () => {
    if (active.status === 'executing') return
    props.rollback.close(active.turn)
  }

  const runConfirm = (scope: 'conversation' | 'conversation-and-files') => {
    if (active.status !== 'ready' || executing) return
    void props.rollback.confirm(props.inputActions, scope)
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
      {active.operation === 'undo' ? <Button type="button" data-modal-autofocus
        disabled={!ready || undoBlocked || executing}
        onClick={() => { runConfirm(undoScope) }}>
        {executing ? modal.executing : modal.confirm}
      </Button> : executing ? <Button type="button" disabled>
        {active.scope === 'conversation' ? modal.executingConversation : modal.executing}
      </Button> : <>
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
  ><RollbackPreview active={active} t={props.t} /></Modal>
}
