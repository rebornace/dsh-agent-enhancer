/**
 * Shared manager chrome for Skills / MCP — peers PluginManagerPage
 * (`@deepseek-ai/dsh-client-ui-plugin-manager`).
 * Add sheet uses primitives `Modal` (body-portaled) so the mask covers the full window.
 */
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './styles.module.css'

export function ManagerPage(props: {
  readonly children: ReactNode
  readonly className?: string
  readonly 'data-state'?: string
}) {
  const className = props.className === undefined || props.className === ''
    ? styles.managerPage
    : `${styles.managerPage} ${props.className}`
  return (
    <div className={className} data-state={props['data-state']}>
      {props.children}
    </div>
  )
}

export function ManagerPageHead(props: {
  readonly title: string
  readonly intro?: string
  readonly toolbar?: ReactNode
}) {
  return (
    <div className={styles.managerPageHead}>
      <div className={styles.managerPageHeading}>
        <h1 className={styles.managerPageTitle}>{props.title}</h1>
        {props.intro !== undefined && props.intro !== '' ? (
          <p className={styles.managerPageIntro}>{props.intro}</p>
        ) : null}
      </div>
      {props.toolbar !== undefined ? (
        <div className={styles.managerToolbar}>{props.toolbar}</div>
      ) : null}
    </div>
  )
}

export function ManagerAddSheet(props: {
  readonly open: boolean
  readonly title: string
  readonly onClose: () => void
  readonly closeLabel: string
  readonly children: ReactNode
  readonly footer: ReactNode
}) {
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      closeLabel={props.closeLabel}
      className={styles.managerSheet}
      contentClassName={styles.managerSheetBody}
      footer={(
        <div className={styles.managerSheetFooter}>{props.footer}</div>
      )}
    >
      {props.children}
    </Modal>
  )
}

export function ManagerDetail(props: {
  readonly crumbLabel: string
  readonly onBack: () => void
  readonly title: string
  readonly description?: string
  readonly actions?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div className={styles.managerDetailTop}>
      <button type="button" className={styles.managerCrumb} onClick={props.onBack}>
        ← {props.crumbLabel}
      </button>
      <div className={styles.managerDetailHead}>
        <h2 className={styles.managerDetailTitle}>{props.title}</h2>
        {props.actions !== undefined ? (
          <div className={styles.managerDetailActions}>{props.actions}</div>
        ) : null}
      </div>
      {props.description !== undefined && props.description !== '' ? (
        <p className={styles.managerDetailDesc}>{props.description}</p>
      ) : null}
      {props.children}
    </div>
  )
}
