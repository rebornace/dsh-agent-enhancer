import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular,
  Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import {
  BROWSER_AGENT_IDLE_CLOSE,
  BROWSER_AGENT_UNATTENDED,
  browserAgentBrowsersForPlatform,
  coerceBrowserAgentBrowserForPlatform,
  detectUiPlatform,
  RUN_ALERTS_LEVELS,
  resolveBrowserAgentBrowser,
  resolveBrowserAgentIdleClose,
  resolveBrowserAgentUnattendedActions,
  resolveBrowserAgentUnattendedMinutes,
  resolveRunAlertsLevel,
} from '../../config.ts'
import type {
  BrowserAgentBrowser,
  BrowserAgentIdleClose,
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
  readonly onBrowserAgentDebugTools?: (enabled: boolean) => void
  readonly onBrowserAgentDemonstrate?: (enabled: boolean) => void
  readonly onBrowserAgentIdleClose?: (value: BrowserAgentIdleClose) => void
  readonly onBrowserAgentUnattendedMinutes?: (value: number) => void
  readonly onBrowserAgentUnattendedActions?: (value: number) => void
  readonly onOpenModel: (feature: ConfigurableAuxiliaryFeature) => void
  /** Jump to the Remote tab from the feature row. */
  readonly onOpenRemote?: () => void
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
    onBrowserAgentDebugTools,
    onBrowserAgentDemonstrate,
    onBrowserAgentIdleClose,
    onBrowserAgentUnattendedMinutes,
    onBrowserAgentUnattendedActions,
    onOpenModel,
    onOpenRemote,
    featureExtraDescription,
  } = props

  const uiPlatform = detectUiPlatform()
  const browserOptions = browserAgentBrowsersForPlatform(uiPlatform)
  const browserValue = coerceBrowserAgentBrowserForPlatform(
    settings.browserAgentBrowser,
    uiPlatform,
  )
  // Simple controls stay visible; only the large browser-agent option set folds.
  const [browserOpen, setBrowserOpen] = useState(false)

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
                  {entry.module === 'remoteControl' ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={styles.settingManageAction}
                      disabled={busy || onOpenRemote === undefined}
                      onClick={onOpenRemote}
                    >
                      <span>{t('remoteManage')}</span>
                    </Button>
                  ) : null}
                  {entry.module === 'browserAgent' ? (
                    <div className={styles.browserAgentDisclosure}>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-expanded={browserOpen}
                        aria-label={`${t('browserAgent')} ${t('settingsAdvanced')}`}
                        disabled={busy}
                        onClick={() => { setBrowserOpen(current => !current) }}
                      >
                        <span>{browserOpen ? t('settingsAdvancedHide') : t('settingsAdvanced')}</span>
                        {browserOpen
                          ? <IconChevronUpOutlineRegular size={14} />
                          : <IconChevronDownOutlineRegular size={14} />}
                      </Button>
                      {browserOpen ? (
                        settings.browserAgentEnabled ? (
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
                            <label className={styles.browserAgentExtraRow}>
                              <span>{t('browserAgentDebugTools')}</span>
                              <Switch
                                label={t('browserAgentDebugTools')}
                                checked={settings.browserAgentDebugTools}
                                disabled={busy || onBrowserAgentDebugTools === undefined}
                                onChange={checked => { onBrowserAgentDebugTools?.(checked) }}
                              />
                            </label>
                            <p className={styles.settingDescription}>{t('browserAgentDebugToolsHint')}</p>
                            <label className={styles.browserAgentExtraRow}>
                              <span>{t('browserAgentDemonstrate')}</span>
                              <Switch
                                label={t('browserAgentDemonstrate')}
                                checked={settings.browserAgentDemonstrate}
                                disabled={busy || onBrowserAgentDemonstrate === undefined}
                                onChange={checked => { onBrowserAgentDemonstrate?.(checked) }}
                              />
                            </label>
                            <p className={styles.settingDescription}>{t('browserAgentDemonstrateHint')}</p>
                            <label className={styles.browserAgentExtraRow}>
                              <span>{t('browserAgentIdleClose')}</span>
                              <select
                                className={styles.settingsSelect}
                                aria-label={t('browserAgentIdleClose')}
                                disabled={busy || onBrowserAgentIdleClose === undefined}
                                value={settings.browserAgentIdleClose}
                                onChange={event => {
                                  onBrowserAgentIdleClose?.(resolveBrowserAgentIdleClose(event.target.value))
                                }}
                              >
                                {BROWSER_AGENT_IDLE_CLOSE.map(value => (
                                  <option key={value} value={value}>
                                    {t(`browserAgentIdleClose_${value}` as 'browserAgentIdleClose_10m')}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <p className={styles.settingDescription}>{t('browserAgentIdleCloseHint')}</p>
                            <div className={styles.browserAgentUnattendedFields}>
                              <label className={styles.browserAgentUnattendedField}>
                                <span>{t('browserAgentUnattendedMinutes')}</span>
                                <input
                                  key={`minutes-${settings.browserAgentUnattendedMinutes}`}
                                  className={styles.settingsSelect}
                                  type="number"
                                  inputMode="numeric"
                                  min={BROWSER_AGENT_UNATTENDED.minutes.min}
                                  max={BROWSER_AGENT_UNATTENDED.minutes.max}
                                  step={1}
                                  aria-label={t('browserAgentUnattendedMinutes')}
                                  disabled={busy || onBrowserAgentUnattendedMinutes === undefined}
                                  defaultValue={settings.browserAgentUnattendedMinutes}
                                  onBlur={event => {
                                    const raw = event.target.value.trim()
                                    const next = raw === ''
                                      ? settings.browserAgentUnattendedMinutes
                                      : resolveBrowserAgentUnattendedMinutes(raw)
                                    event.target.value = String(next)
                                    if (next !== settings.browserAgentUnattendedMinutes) {
                                      onBrowserAgentUnattendedMinutes?.(next)
                                    }
                                  }}
                                  onKeyDown={event => {
                                    if (event.key === 'Enter') event.currentTarget.blur()
                                  }}
                                />
                              </label>
                              <label className={styles.browserAgentUnattendedField}>
                                <span>{t('browserAgentUnattendedActions')}</span>
                                <input
                                  key={`actions-${settings.browserAgentUnattendedActions}`}
                                  className={styles.settingsSelect}
                                  type="number"
                                  inputMode="numeric"
                                  min={BROWSER_AGENT_UNATTENDED.actions.min}
                                  max={BROWSER_AGENT_UNATTENDED.actions.max}
                                  step={1}
                                  aria-label={t('browserAgentUnattendedActions')}
                                  disabled={busy || onBrowserAgentUnattendedActions === undefined}
                                  defaultValue={settings.browserAgentUnattendedActions}
                                  onBlur={event => {
                                    const raw = event.target.value.trim()
                                    const next = raw === ''
                                      ? settings.browserAgentUnattendedActions
                                      : resolveBrowserAgentUnattendedActions(raw)
                                    event.target.value = String(next)
                                    if (next !== settings.browserAgentUnattendedActions) {
                                      onBrowserAgentUnattendedActions?.(next)
                                    }
                                  }}
                                  onKeyDown={event => {
                                    if (event.key === 'Enter') event.currentTarget.blur()
                                  }}
                                />
                              </label>
                            </div>
                            <p className={styles.settingDescription}>{t('browserAgentUnattendedLimitsHint')}</p>
                          </div>
                        ) : (
                          <p className={styles.settingDescription}>{t('settingsEnableFirst')}</p>
                        )
                      ) : null}
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`${t(entry.labelKey)} ${t('settingsOpenModel')}`}
                      onClick={() => {
                        if (entry.modelFeature !== null) onOpenModel(entry.modelFeature)
                      }}
                    >
                      <span>{t('settingsOpenModel')}</span>
                      <IconChevronRightOutlineRegular size={14} />
                    </Button>
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
