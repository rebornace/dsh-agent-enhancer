import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { UsageRange, UsageSummary } from '../../host/usage/types.ts'
import styles from '../styles.module.css'
import { UsagePanel } from './usage-panel.tsx'

export interface UsageRightTabProps extends PropsRuntime<'sidebar.right.pane.tab'> {
  readonly t: TranslateNS<'agent-enhancer'>
  readonly loadUsage: (range: UsageRange) => Promise<UsageSummary>
}

export function UsageRightTab(props: UsageRightTabProps) {
  return (
    <div className={styles.usageRightPane}>
      <UsagePanel t={props.t} loadUsage={props.loadUsage} />
    </div>
  )
}

export function UsageRightTabTitle(props: PropsRuntime<'sidebar.right.pane.tab.title'> & {
  readonly t: TranslateNS<'agent-enhancer'>
}) {
  return <span>{props.t('usageTitle')}</span>
}
