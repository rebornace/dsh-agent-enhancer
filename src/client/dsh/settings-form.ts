import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { EnhancerSettings } from '../../config.ts'

export type SettingsForm = Pick<ConfigForm<EnhancerSettings>, 'getSnapshot' | 'subscribe' | 'set'>
type Field = keyof EnhancerSettings
type Accepted = { readonly value: boolean; readonly revision: number | undefined }

export class AcceptedSettingsForm implements SettingsForm {
  private readonly listeners = new Set<() => void>()
  private readonly accepted = new Map<Field, Accepted>()
  private snapshot: ConfigFormSnapshot<EnhancerSettings>

  constructor(private readonly form: SettingsForm) {
    this.snapshot = form.getSnapshot()
  }

  getSnapshot(): ConfigFormSnapshot<EnhancerSettings> {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    const unsubscribe = this.form.subscribe(() => {
      this.refresh()
      listener()
    })
    return () => {
      this.listeners.delete(listener)
      unsubscribe()
    }
  }

  async set(field: Field, value: boolean): Promise<boolean> {
    const revision = this.form.getSnapshot().revision
    const accepted = await this.form.set(field, value)
    if (accepted) {
      this.accepted.set(field, { value, revision })
      this.refresh()
      for (const listener of this.listeners) listener()
    }
    return accepted
  }

  private refresh(): void {
    const current = this.form.getSnapshot()
    const value = { ...current.value } as Record<Field, boolean | undefined>
    let overridden = false
    for (const [field, accepted] of this.accepted) {
      if (current.value?.[field] === accepted.value ||
        current.revision !== undefined && (accepted.revision === undefined || current.revision > accepted.revision)) {
        this.accepted.delete(field)
      } else {
        value[field] = accepted.value
        overridden = true
      }
    }
    this.snapshot = overridden ? { ...current, value: value as EnhancerSettings } : current
  }
}
