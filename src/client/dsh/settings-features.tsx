import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronRightOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  RUN_ALERTS_LEVELS,
  resolveRunAlertsLevel,
} from '../../config.ts'
import type {
  ConfigurableAuxiliaryFeature,
  EnhancerSettings,
  ModuleName,
  RunAlertsLevel,
} from '../../config.ts'
import styles from '../styles.module.css'
import { SETTINGS_FEATURE_GROUPS } from './settings-catalog.ts'

export interface SettingsFeaturesPanelProps {
  readonly settings: EnhancerSettings
  readonly busy: boolean
  readonly t: TranslateNS<'agent-enhancer'>
  readonly onToggle: (module: ModuleName, checked: boolean) => void
  readonly onRunAlertsLevel?: (level: RunAlertsLevel) => void
  readonly onOpenModel: (feature: ConfigurableAuxiliaryFeature) => void
  /** Optional per-module extra description (e.g. host capability warnings). */
  readonly featureExtraDescription?: (module: ModuleName) => string | undefined
}

function runAlertsLevelLabel(
  level: RunAlertsLevel,
  t: TranslateNS<'agent-enhancer'>,
): string {
  switch (level) {
    case 'hidden':
      return t('runAlertsLevel_hidden')
    case 'unfocused':
      return t('runAlertsLevel_unfocused')
    case 'always':
      return t('runAlertsLevel_always')
    default: {
      const _exhaustive: never = level
      return _exhaustive
    }
  }
}

export function SettingsFeaturesPanel(props: SettingsFeaturesPanelProps) {
  const {
    settings,
    busy,
    t,
    onToggle,
    onRunAlertsLevel,
    onOpenModel,
    featureExtraDescription,
  } = props

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
                  {featureExtraDescription?.(entry.module) !== undefined ? (
                    <p className={styles.settingDescription} role="note">
                      {featureExtraDescription(entry.module)}
                    </p>
                  ) : null}
                </div>
                <div className={styles.settingControls}>
                  {entry.module === 'runAlerts' && settings.runAlertsEnabled ? (
                    <select
                      className={styles.settingsSelect}
                      aria-label={t('runAlertsLevel')}
                      disabled={busy || onRunAlertsLevel === undefined}
                      value={settings.runAlertsLevel}
                      onChange={event => {
                        onRunAlertsLevel?.(resolveRunAlertsLevel(event.target.value))
                      }}
                    >
                      {RUN_ALERTS_LEVELS.map(level => (
                        <option key={level} value={level}>
                          {runAlertsLevelLabel(level, t)}
                        </option>
                      ))}
                    </select>
                  ) : null}
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
