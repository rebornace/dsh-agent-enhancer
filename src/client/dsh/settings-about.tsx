import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ApplyUpdateResult, UpdateCheckResult } from '../../host/update/types.ts'
import styles from '../styles.module.css'
import { SettingsUpdateSection } from './settings-update.tsx'

export interface SettingsAboutPanelProps {
  readonly t: TranslateNS<'agent-enhancer'>
  readonly checkUpdate?: () => Promise<UpdateCheckResult>
  readonly applyUpdate?: () => Promise<ApplyUpdateResult>
}

export function SettingsAboutPanel(props: SettingsAboutPanelProps) {
  const { t, checkUpdate, applyUpdate } = props

  return (
    <div className={styles.settingsPanel} data-settings-panel="about">
      {checkUpdate !== undefined && (
        <section className={styles.settingsGroup} aria-label={t('updateTitle')}>
          <h3 className={styles.settingsGroupTitle}>{t('updateTitle')}</h3>
          <SettingsUpdateSection checkUpdate={checkUpdate} applyUpdate={applyUpdate} t={t} />
        </section>
      )}
      <aside aria-label={t('privacyTitle')} className={styles.privacy}>
        <h3 className={styles.settingsGroupTitle}>{t('privacyTitle')}</h3>
        <p>{t('privacy')}</p>
        <p>{t('rollbackBoundary')}</p>
        <p>{t('coexistence')}</p>
      </aside>
    </div>
  )
}
