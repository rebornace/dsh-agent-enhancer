import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { EnhancerSettings } from '../../config.ts'

export type SettingsForm = Pick<ConfigForm<EnhancerSettings>, 'getSnapshot' | 'subscribe' | 'set' | 'mutate'>
type Field = keyof EnhancerSettings
type FieldValue = EnhancerSettings[Field]
type Accepted = { readonly value: FieldValue; readonly revision: number | undefined }

type SettingsPathOp = {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

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

  async set(field: string, value: unknown): Promise<boolean> {
    return this.mutate([{ op: 'set', path: [field], value }])
  }

  /**
   * Optimistic overlay after a successful fence-free Host write (see
   * `persistEnhancerSettings`). Keeps pills in sync until ConfigForm mirrors
   * the document-updated event.
   */
  acceptLocal(ops: readonly SettingsPathOp[]): void {
    this.remember(ops)
  }

  /**
   * Fallback Host write through ConfigForm. Prefer `persistEnhancerSettings`
   * for UI saves — ConfigForm always attaches a revision fence.
   */
  async mutate(
    ops: readonly SettingsPathOp[],
    expectedRevision?: number,
  ): Promise<boolean> {
    const accepted = expectedRevision === undefined
      ? await this.form.mutate(ops as never)
      : await this.form.mutate(ops as never, expectedRevision)
    if (!accepted && expectedRevision === undefined) {
      const retried = await this.form.mutate(ops as never)
      if (retried) {
        this.remember(ops)
        return true
      }
      return false
    }
    if (accepted) this.remember(ops)
    return accepted
  }

  private remember(ops: readonly SettingsPathOp[]): void {
    const revision = this.form.getSnapshot().revision
    for (const op of ops) {
      if (op.op !== 'set' || op.path.length !== 1) continue
      const key = op.path[0] as Field
      this.accepted.set(key, { value: op.value as FieldValue, revision })
    }
    this.refresh()
    for (const listener of this.listeners) listener()
  }

  private refresh(): void {
    const current = this.form.getSnapshot()
    const value = { ...current.value } as Record<Field, FieldValue | undefined>
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
