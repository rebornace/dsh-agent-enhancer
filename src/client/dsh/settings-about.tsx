import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import styles from '../styles.module.css'

export interface SettingsAboutPanelProps {
  readonly t: TranslateNS<'agent-enhancer'>
}

export function SettingsAboutPanel(props: SettingsAboutPanelProps) {
  const { t } = props

  return (
    <div className={styles.settingsPanel} data-settings-panel="about">
      <aside aria-label={t('privacyTitle')} className={styles.privacy}>
        <h3 className={styles.settingsGroupTitle}>{t('privacyTitle')}</h3>
        <p>{t('privacy')}</p>
        <p>{t('rollbackBoundary')}</p>
        <p>{t('coexistence')}</p>
      </aside>
    </div>
  )
}
