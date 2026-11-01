import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, useSyncExternalStore } from 'react'
import { MODULES, resolveSettings } from '../../config.ts'
import type { EnhancerSettings, ModuleName } from '../../config.ts'
import styles from '../styles.module.css'

type SettingsForm = Pick<ConfigForm<EnhancerSettings>, 'getSnapshot' | 'subscribe' | 'set'>

export interface PluginSettingsProps {
  readonly form: SettingsForm
  readonly t: TranslateNS<'composer-enhancer'>
}

const LABELS = {
  history: 'history',
  optimize: 'optimize',
  predict: 'predict',
  rollback: 'rollback',
} as const

const DESCRIPTIONS = {
  history: 'historyDescription',
  optimize: 'optimizeDescription',
  predict: 'predictDescription',
  rollback: 'rollbackDescription',
} as const

export function PluginSettings({ form, t }: PluginSettingsProps) {
  const formState = useSyncExternalStore(
    listener => form.subscribe(listener),
    () => form.getSnapshot(),
  )
  const settings = resolveSettings(formState.value)
  const [saving, setSaving] = useState<ModuleName | null>(null)
  const [error, setError] = useState(false)
  const onChange = async (module: ModuleName, checked: boolean) => {
    setSaving(module)
    setError(false)
    try {
      const accepted = await form.set(`${module}Enabled`, checked)
      if (!accepted) setError(true)
    } catch {
      setError(true)
    } finally {
      setSaving(null)
    }
  }
  return <section aria-label={t('settingsTitle')} className={styles.settings}>
    <header className={styles.settingsHeader}>
      <h2>{t('settingsTitle')}</h2>
      <p>{t('settingsSubtitle')}</p>
    </header>
    {MODULES.map(module => <div key={module} className={styles.settingRow}>
      <div className={styles.settingText}>
        <h3>{t(LABELS[module])}</h3>
        <p className={styles.settingDescription}>{t(DESCRIPTIONS[module])}</p>
      </div>
      <Switch
        label={t(LABELS[module])}
        checked={settings[`${module}Enabled`]}
        disabled={!formState.writable || saving !== null}
        onChange={checked => { void onChange(module, checked) }}
      />
    </div>)}
    {error && <p role="status">{t('settingsError')}</p>}
    <aside aria-label="Data and privacy" className={styles.privacy}>
      <h3>{t('privacyTitle')}</h3>
      <p>{t('privacy')}</p>
      <p>{t('rollbackBoundary')}</p>
      <p>{t('coexistence')}</p>
    </aside>
  </section>
}
