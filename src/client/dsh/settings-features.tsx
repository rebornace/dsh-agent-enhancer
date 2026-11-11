import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronRightOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  browserAgentBrowsersForPlatform,
  coerceBrowserAgentBrowserForPlatform,
  detectUiPlatform,
  RUN_ALERTS_LEVELS,
  resolveBrowserAgentBrowser,
  resolveRunAlertsLevel,
} from '../../config.ts'
import type {
  BrowserAgentBrowser,
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
  readonly onBrowserAgentBrowser?: (browser: BrowserAgentBrowser) => void
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

function browserAgentBrowserLabel(
  browser: BrowserAgentBrowser,
  t: TranslateNS<'agent-enhancer'>,
): string {
  switch (browser) {
    case 'auto':
      return t('browserAgentBrowser_auto')
    case 'chrome':
      return t('browserAgentBrowser_chrome')
    case 'edge':
      return t('browserAgentBrowser_edge')
    case 'safari':
      return t('browserAgentBrowser_safari')
    default: {
      const _exhaustive: never = browser
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
    onBrowserAgentBrowser,
    onOpenModel,
    featureExtraDescription,
  } = props

  const uiPlatform = detectUiPlatform()
  const browserOptions = browserAgentBrowsersForPlatform(uiPlatform)
  const browserValue = coerceBrowserAgentBrowserForPlatform(
    settings.browserAgentBrowser,
    uiPlatform,
  )

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
                  {entry.module === 'browserAgent' && settings.browserAgentEnabled ? (
                    <div className={styles.browserAgentExtras}>
                      <label className={styles.browserAgentExtraRow}>
                        <span>{t('browserAgentBrowser')}</span>
                        <select
                          className={styles.settingsSelect}
                          aria-label={t('browserAgentBrowser')}
                          disabled={busy || onBrowserAgentBrowser === undefined}
                          value={browserValue}
                          onChange={event => {
                            onBrowserAgentBrowser?.(resolveBrowserAgentBrowser(event.target.value))
                          }}
                        >
                          {browserOptions.map(browser => (
                            <option key={browser} value={browser}>
                              {browserAgentBrowserLabel(browser, t)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className={styles.settingDescription}>{t('browserAgentOpenLinkHint')}</p>
                    </div>
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
