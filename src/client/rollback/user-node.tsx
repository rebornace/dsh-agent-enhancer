import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCheckOutlineRegular,
  IconCopyOutlineRegular,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import styles from '../styles.module.css'
import { RollbackMessageActions } from './actions.tsx'
import { contentParts } from './content-parts.ts'
import type { RollbackController } from './controller.ts'
import { isRollbackMarkerMessage, turnFromRollbackMarkerId } from './marker.ts'

export type RollbackUserNodeProps = ChatNodeViewProps<'user'> & {
  readonly rollback: RollbackController
  readonly tEnhancer: TranslateNS<'composer-enhancer'>
  readonly tChat: TranslateNS<'chat'>
}

function turnOf(location: RollbackUserNodeProps['node']['location']): TurnLocation | null {
  return location.kind === 'turn' || location.kind === 'step' ? location.turn : null
}

function UserCopyAction({ text, tChat }: {
  readonly text: string
  readonly tChat: TranslateNS<'chat'>
}) {
  const [copied, setCopied] = useState(false)
  const copyPending = useRef(false)
  const copyTimer = useRef<number | null>(null)
  const copyEpoch = useRef(0)
  useEffect(() => () => {
    copyEpoch.current += 1
    copyPending.current = false
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
  }, [])
  const onCopy = useCallback(() => {
    if (copied || copyPending.current) return
    const epoch = copyEpoch.current
    copyPending.current = true
    void writeClipboard(text).then(ok => {
      if (epoch !== copyEpoch.current) return
      copyPending.current = false
      if (!ok) return
      setCopied(true)
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null
        setCopied(false)
      }, 1000)
    })
  }, [copied, text])
  return <Tooltip label={copied ? tChat('copied') : tChat('copy')} side="bottom">
    <button type="button" className={styles.userMessageAction} aria-label={copied ? tChat('copied') : tChat('copy')}
      onClick={onCopy}>
      {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
    </button>
  </Tooltip>
}

export function RollbackUserNode(props: RollbackUserNodeProps) {
  const data = props.node.data
  const messageId = (data as { id?: string }).id
  const parts = useMemo(() => contentParts(data.content), [data.content])
  const prepared = useMemo(() => ({
    text: parts.text,
    attachments: parts.attachments,
    extraBlocks: parts.rest,
    ...(data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }),
  }), [parts, data.referenceLabels])
  const facts = useMemo(() => ({
    ...(data.referenceLabels === undefined ? {} : { sessionLabels: data.referenceLabels }),
    ...(data.skillNames === undefined ? {} : { skillNames: data.skillNames }),
  }), [data.referenceLabels, data.skillNames])
  const turn = turnOf(props.node.location)
  const chat = props.useChat(state => state)
  const isUndoTip = isRollbackMarkerMessage(data.source, messageId) && chat.order.at(-1) === props.node.key
  const rollbackTurn = turnFromRollbackMarkerId(messageId) ?? turn?.turn
  const rollbackEnabled = useSyncExternalStore(props.rollback.subscribe, props.rollback.getSnapshot).enabled

  return <div className={styles.userMessageRow}>
    {props.renderFactorySlot('conversation.chat.user.content', {
      content: prepared,
      loadImage: props.loadImage,
      facts,
      interactive: true,
    })}
    <div className={styles.userMessageActions} data-clock="start">
      <UserCopyAction text={prepared.text} tChat={props.tChat} />
      {rollbackEnabled && turn !== null && rollbackTurn !== undefined && !isRollbackMarkerMessage(data.source, messageId)
        ? <RollbackMessageActions {...props} t={props.tEnhancer} turn={turn} operation="rollback" /> : null}
      {rollbackEnabled && turn !== null && rollbackTurn !== undefined && isUndoTip
        ? <RollbackMessageActions {...props} t={props.tEnhancer} turn={{ ...turn, turn: rollbackTurn }} operation="undo" /> : null}
    </div>
  </div>
}
