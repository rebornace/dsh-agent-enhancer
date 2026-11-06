/**
 * Host settings write for the enhancer namespace.
 *
 * Typert requires arity 3 (`expected 3 argument(s), got 2`). Trailing
 * `undefined` becomes `null` on the JSON wire, and Host treats null as a real
 * expected revision (always conflicts). Always pass a numeric revision.
 *
 * When ConfigForm's mirrored revision is stale, refresh via describe and retry
 * once — same recovery idea as ConfigForm.recover, without its pre-queue pin.
 */

export const ENHANCER_SETTINGS_NS = 'agent-enhancer'

export type SettingsPersistOp = {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

type SettingsMutateOk = { readonly ok: true; readonly value?: unknown }
type SettingsMutateFail = {
  readonly ok: false
  readonly error?: { readonly message?: string } | string
}
type SettingsMutateResponse = SettingsMutateOk | SettingsMutateFail

type SettingsDescribeOk = {
  readonly ok: true
  readonly value: {
    readonly namespaces?: ReadonlyArray<{ readonly ns: string; readonly revision: number }>
  }
}
type SettingsDescribeFail = { readonly ok: false; readonly error?: unknown }
type SettingsDescribeResponse = SettingsDescribeOk | SettingsDescribeFail

export type SettingsRemote = {
  readonly settings: {
    readonly mutate: (
      ns: string,
      ops: readonly SettingsPersistOp[],
      expectedRevision: number,
    ) => Promise<SettingsMutateResponse>
    readonly describe?: () => Promise<SettingsDescribeResponse>
  }
}

export type RevisionReader = () => number | undefined

function refusalMessage(error: SettingsMutateFail['error']): string {
  if (typeof error === 'string' && error.trim() !== '') return error
  if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message.trim() !== '') {
    return error.message
  }
  return 'settings mutate refused'
}

function revisionOrZero(readRevision: RevisionReader | undefined): number {
  const revision = readRevision?.()
  return typeof revision === 'number' && Number.isFinite(revision) ? revision : 0
}

/**
 * Soft-resolve `remote.settings`. Cordis blocks nested faces that are not in
 * `inject`, so callers that did not hard-inject must use
 * {@link withSettingsRemote} (lazy inject) instead of this alone.
 */
export function settingsRemoteOf(remote: unknown): SettingsRemote {
  if (remote === undefined || remote === null || typeof remote !== 'object') {
    throw new Error('remote.settings unavailable')
  }
  let settings: unknown
  try {
    settings = Reflect.get(remote, 'settings')
  } catch {
    settings = undefined
  }
  if (
    settings === undefined
    || settings === null
    || typeof settings !== 'object'
    || typeof Reflect.get(settings, 'mutate') !== 'function'
  ) {
    throw new Error('remote.settings unavailable')
  }
  return { settings: settings as SettingsRemote['settings'] }
}

type InjectHost = {
  readonly inject: (
    deps: readonly string[],
    callback: (scope: { readonly remote: unknown }) => void | (() => void),
  ) => { readonly dispose: () => void | Promise<void> }
}

/**
 * Run `run` with `remote.settings` available via a one-shot Cordis inject.
 * Avoids putting `remote.settings` on the plugin's boot `inject` list (that
 * delayed Desktop account paint).
 */
export async function withSettingsRemote<T>(
  ctx: InjectHost,
  run: (remote: unknown) => Promise<T>,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const fiber = ctx.inject(['remote.settings'], scope => {
      void Promise.resolve()
        .then(() => run(scope.remote))
        .then(
          value => {
            finish(() => { resolve(value) })
          },
          error => {
            finish(() => { reject(error) })
          },
        )
        .finally(() => {
          void Promise.resolve(fiber.dispose()).catch(() => undefined)
        })
    })
  })
}

async function revisionFromDescribe(remote: SettingsRemote): Promise<number | undefined> {
  if (remote.settings.describe === undefined) return undefined
  try {
    const response = await remote.settings.describe()
    if (!response.ok) return undefined
    const row = response.value.namespaces?.find(entry => entry.ns === ENHANCER_SETTINGS_NS)
    return row?.revision
  } catch {
    return undefined
  }
}

/** Persist enhancer config. Throws with Host detail on refusal. */
export async function persistEnhancerSettings(
  remote: unknown,
  ops: readonly SettingsPersistOp[],
  readRevision?: RevisionReader,
): Promise<void> {
  const settingsRemote = settingsRemoteOf(remote)
  const firstRevision = revisionOrZero(readRevision)
  const first = await settingsRemote.settings.mutate(ENHANCER_SETTINGS_NS, ops, firstRevision)
  if (first.ok) return

  // Only on save failure — never on boot. Prefer describe so we do not invent revisions.
  const described = await revisionFromDescribe(settingsRemote)
  const mirrored = revisionOrZero(readRevision)
  const retryRevision = described ?? (mirrored !== firstRevision ? mirrored : firstRevision)
  const second = await settingsRemote.settings.mutate(ENHANCER_SETTINGS_NS, ops, retryRevision)
  if (second.ok) return

  throw new Error(refusalMessage(second.error ?? first.error))
}
