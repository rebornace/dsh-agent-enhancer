import { useEffect, useRef } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { auxiliaryModelOf } from '../../config.ts'
import type { ConfigurableAuxiliaryFeature, EnhancerSettings } from '../../config.ts'
import styles from '../styles.module.css'
import {
  AUTO_TIERS,
  AUTO_TIER_LABELS,
  MODEL_FEATURE_ROWS,
} from './settings-catalog.ts'
import type { AutoRouteTier } from './settings-catalog.ts'
import { ModelPill, autoTierSelection } from './settings-model-pill.tsx'

export interface SettingsModelsPanelProps {
  readonly settings: EnhancerSettings
  readonly groups: readonly ModelProviderGroup[]
  readonly catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  readonly busy: boolean
  readonly t: TranslateNS<'agent-enhancer'>
  readonly highlightFeature: ConfigurableAuxiliaryFeature | null
  readonly onRefreshCatalog: () => void
  readonly onModelSelect: (feature: ConfigurableAuxiliaryFeature, id: string) => void
  readonly onAutoTierSelect: (tier: AutoRouteTier, id: string) => void
  readonly onClassifierToggle: (checked: boolean) => void
}

export function SettingsModelsPanel(props: SettingsModelsPanelProps) {
  const {
    settings,
    groups,
    catalogStatus,
    busy,
    t,
    highlightFeature,
    onRefreshCatalog,
    onModelSelect,
    onAutoTierSelect,
    onClassifierToggle,
  } = props
  const highlightRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (highlightFeature === null) return
    highlightRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [highlightFeature])

  return (
    <div className={styles.settingsPanel} data-settings-panel="models">
      <section className={styles.settingsGroup} aria-label={t('settingsAuxModelsTitle')}>
        <h3 className={styles.settingsGroupTitle}>{t('settingsAuxModelsTitle')}</h3>
        <p className={styles.settingsGroupIntro}>{t('settingsAuxModelsIntro')}</p>
        <div className={styles.settingsGroupBody}>
          {MODEL_FEATURE_ROWS.map(row => {
            const selection = auxiliaryModelOf(settings, row.feature)
            const highlighted = highlightFeature === row.feature
            return (
              <div
                key={row.feature}
                className={highlighted ? `${styles.settingRow} ${styles.settingRowHighlight}` : styles.settingRow}
                ref={highlighted ? highlightRef : undefined}
                data-settings-feature={row.feature}
              >
                <div className={styles.settingText}>
                  <div className={styles.settingTitle}>{t(row.titleKey)}</div>
                  <p className={styles.settingDescription}>{t('modelLabel')}</p>
                </div>
                <div className={styles.settingControls}>
                  <ModelPill
                    selection={selection}
                    groups={groups}
                    catalogStatus={catalogStatus}
                    disabled={busy || !settings[`${row.enabledModule}Enabled`]}
                    t={t}
                    ariaLabel={`${t(row.titleKey)} ${t('modelLabel')}`}
                    includeSessionOptions
                    onOpen={onRefreshCatalog}
                    onSelect={id => { onModelSelect(row.feature, id) }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className={styles.settingsGroup} aria-label={t('autoRouting')}>
        <h3 className={styles.settingsGroupTitle}>{t('autoRouting')}</h3>
        <p className={styles.settingsGroupIntro}>{t('autoRoutingDescription')}</p>
        <div className={styles.settingsGroupBody}>
          <div className={styles.settingRow}>
            <div className={styles.settingText}>
              <div className={styles.settingTitle}>{t('autoClassifier')}</div>
              <p className={styles.settingDescription}>{t('autoClassifierDescription')}</p>
            </div>
            <div className={styles.settingControls}>
              <Switch
                label={t('autoClassifier')}
                checked={settings.autoClassifierEnabled}
                disabled={busy}
                onChange={checked => { onClassifierToggle(checked) }}
              />
            </div>
          </div>
        </div>
        <div className={styles.autoMappingSection} aria-label={t('autoMappingTitle')}>
          <h3 className={styles.settingsGroupTitle}>{t('autoMappingTitle')}</h3>
          {AUTO_TIERS.map(tier => {
            const tierSelection = autoTierSelection(settings, tier)
            return (
              <div key={tier} className={styles.settingRow}>
                <div className={styles.settingText}>
                  <div className={styles.settingTitle}>{t(AUTO_TIER_LABELS[tier])}</div>
                </div>
                <div className={styles.settingControls}>
                  <ModelPill
                    selection={tierSelection}
                    groups={groups}
                    catalogStatus={catalogStatus}
                    disabled={busy}
                    t={t}
                    ariaLabel={`${t(AUTO_TIER_LABELS[tier])} ${t('modelLabel')}`}
                    includeSessionOptions={false}
                    onOpen={onRefreshCatalog}
                    onSelect={id => { onAutoTierSelect(tier, id) }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
