import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import styles from '../styles.module.css'
import { openFileEditor } from './open-tab.ts'
import type { FileEditNavigator } from './open-tab.ts'
import './slot-types.ts'

export interface FileEditDocumentActionProps {
  readonly absolutePath?: string
  readonly sessionId: SessionId
  readonly t: TranslateNS<'agent-enhancer'>
  readonly sidebarRight: FileEditNavigator | undefined
}

function ownerPath(props: FileEditDocumentActionProps): string {
  if (typeof props.absolutePath === 'string' && props.absolutePath.trim() !== '') {
    return props.absolutePath
  }
  return ''
}

export function FileEditDocumentAction(props: FileEditDocumentActionProps) {
  const path = ownerPath(props)
  if (path === '') return null
  return (
    <button
      type="button"
      className={styles.fileEditAction}
      title={props.t('fileEditActionHint')}
      aria-label={props.t('fileEdit')}
      onClick={() => openFileEditor(props.sidebarRight, props.sessionId, path)}
    >
      {props.t('fileEdit')}
    </button>
  )
}
