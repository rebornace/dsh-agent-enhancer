import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronRightOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EnhancerSettings, ModuleName } from '../../config.ts'
import type { ConfigurableAuxiliaryFeature } from '../../config.ts'
import styles from '../styles.module.css'
import { SETTINGS_FEATURE_GROUPS } from './settings-catalog.ts'

export interface SettingsFeaturesPanelProps {
  readonly settings: EnhancerSettings
  readonly busy: boolean
  readonly t: TranslateNS<'agent-enhancer'>
  readonly onToggle: (module: ModuleName, checked: boolean) => void
  readonly onOpenModel: (feature: ConfigurableAuxiliaryFeature) => void
}

export function SettingsFeaturesPanel(props: SettingsFeaturesPanelProps) {
  const { settings, busy, t, onToggle, onOpenModel } = props

  return (
    <div className={styles.settingsPanel} data-settings-panel="features">
      {SETTINGS_FEATURE_GROUPS.map(group => (
        <section key={group.id} className={styles.settingsGroup} aria-label={t(group.titleKey)}>
          <h3 className={styles.settingsGroupTitle}>{t(group.titleKey)}</h3>
          <div className={styles.settingsGroupBody}>
            {group.entries.map(entry => (
              <div key={entry.module} className={styles.settingRow}>
                <div className={styles.settingText}>
                  <div className={styles.settingTitle}>{t(entry.labelKey)}</div>
                  <p className={styles.settingDescription}>{t(entry.descriptionKey)}</p>
                </div>
                <div className={styles.settingControls}>
                  {entry.modelFeature !== null && (
                    <button
                      type="button"
                      className={styles.settingsLink}
                      disabled={busy}
                      aria-label={`${t(entry.labelKey)} ${t('settingsOpenModel')}`}
                      onClick={() => {
                        if (entry.modelFeature !== null) onOpenModel(entry.modelFeature)
                      }}
                    >
                      <span>{t('settingsOpenModel')}</span>
                      <IconChevronRightOutlineRegular />
                    </button>
                  )}
                  <Switch
                    label={t(entry.labelKey)}
                    checked={settings[`${entry.module}Enabled`]}
                    disabled={busy}
                    onChange={checked => { onToggle(entry.module, checked) }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
