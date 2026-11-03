import type {
  ProviderBalanceSnapshot,
  ProviderBalanceStatus,
  ProviderBalances,
  UsageBalance,
} from './types.ts'

export const DEFAULT_BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'
export const DEFAULT_BALANCE_REFRESH_MS = 60_000
export const DEFAULT_BALANCE_TIMEOUT_MS = 5_000
export const DEFAULT_BALANCE_API_KEY_REF = 'DEEPSEEK_API_KEY'
export const PROVIDER_BALANCE_ACCOUNT_KEY = 'llm-deepseek-account'
/** Cordis entry id in product profiles — not the package name `llm-deepseek-api-key`. */
export const PROVIDER_BALANCE_API_KEY_KEY = 'llm-deepseek'

export type UsageBalanceStatus = 'ready' | 'no-key' | 'unavailable'

export type { ProviderBalanceSnapshot, ProviderBalanceStatus, ProviderBalances }

export interface ParsedBalanceInfo {
  readonly available: boolean
  readonly currency: string
  readonly total: string
  readonly granted: string
  readonly toppedUp: string
}

/** Minimal credentials seam — Desktop owns the secret, never this plugin. */
export interface CredentialsResolver {
  resolve(ref: unknown): Promise<{ readonly value: string } | undefined>
}

function asRecord(value: unknown): { readonly [key: string]: unknown } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as { readonly [key: string]: unknown }
}

/** Normalize money to exactly two decimal places for display. */
function moneyString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value.toFixed(2)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value.trim())
    if (!Number.isFinite(parsed) || parsed < 0) return undefined
    return parsed.toFixed(2)
  }
  return undefined
}

/** Pure parse of DeepSeek `GET /user/balance` JSON. Prefers CNY, then USD. */
export function parseBalanceResponse(json: unknown): ParsedBalanceInfo | undefined {
  const body = asRecord(json)
  if (body === undefined || !Array.isArray(body.balance_infos)) return undefined
  const infos: ParsedBalanceInfo[] = []
  for (const item of body.balance_infos) {
    const row = asRecord(item)
    if (row === undefined) continue
    const currency = typeof row.currency === 'string' ? row.currency.trim().toUpperCase() : ''
    const total = moneyString(row.total_balance)
    const granted = moneyString(row.granted_balance)
    const toppedUp = moneyString(row.topped_up_balance)
    if (currency === '' || total === undefined || granted === undefined || toppedUp === undefined) {
      continue
    }
    infos.push({
      available: body.is_available === true,
      currency,
      total,
      granted,
      toppedUp,
    })
  }
  if (infos.length === 0) return undefined
  return infos.find(info => info.currency === 'CNY')
    ?? infos.find(info => info.currency === 'USD')
    ?? infos[0]
}

/**
 * Brand a credential ref when `@deepseek-ai/dsh-credentials` is resolvable.
 * Never statically import that package — Desktop may not expose it to this
 * plugin's node resolution, and a hard import would take down the whole host.
 */
async function brandCredentialRef(refName: string): Promise<unknown> {
  try {
    const mod = await import('@deepseek-ai/dsh-credentials') as {
      credentialRef?: (value: string) => unknown
    }
    if (typeof mod.credentialRef === 'function') return mod.credentialRef(refName)
  } catch {
    // Package absent from this install — fall back to the raw name.
  }
  return refName
}

/**
 * Resolve the DeepSeek inference key the same way official adapters do:
 * Desktop `ctx.credentials` first (Models page / `.credentials.yaml`), then
 * process env. The plugin never stores or ships a key.
 */
export async function resolveDeepSeekApiKey(options: {
  readonly credentials?: CredentialsResolver
  readonly env?: NodeJS.ProcessEnv
  readonly refName?: string
} = {}): Promise<string | undefined> {
  const refName = options.refName ?? DEFAULT_BALANCE_API_KEY_REF
  const credentials = options.credentials
  if (credentials !== undefined) {
    try {
      const ref = await brandCredentialRef(refName)
      const hit = await credentials.resolve(ref)
      const value = hit?.value.trim()
      if (value !== undefined && value !== '') return value
    } catch {
      // Fall through to env — credentials seam may reject an unbranded ref.
    }
  }
  const fromEnv = (options.env ?? process.env)[refName]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return undefined
}

export interface BalanceFetchOptions {
  readonly endpoint?: string
  readonly timeoutMs?: number
  readonly apiKey?: string
  readonly credentials?: CredentialsResolver
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
  readonly fetchImpl?: typeof fetch
}

export async function fetchDeepSeekBalance(
  options: BalanceFetchOptions = {},
): Promise<{ balance?: UsageBalance, status: UsageBalanceStatus }> {
  try {
    const apiKey = options.apiKey ?? await resolveDeepSeekApiKey({
      credentials: options.credentials,
      env: options.env,
    })
    if (apiKey === undefined || apiKey === '') {
      return { status: 'no-key' }
    }
    const endpoint = options.endpoint ?? DEFAULT_BALANCE_ENDPOINT
    const timeoutMs = options.timeoutMs ?? DEFAULT_BALANCE_TIMEOUT_MS
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') return { status: 'unavailable' }
    const now = options.now ?? Date.now
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    try {
      const response = await fetchImpl(endpoint, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      })
      if (!response.ok) return { status: 'unavailable' }
      const parsed = parseBalanceResponse(await response.json())
      if (parsed === undefined) return { status: 'unavailable' }
      return {
        status: 'ready',
        balance: {
          available: parsed.available,
          currency: parsed.currency,
          total: parsed.total,
          granted: parsed.granted,
          toppedUp: parsed.toppedUp,
          checkedAt: now(),
        },
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return { status: 'unavailable' }
  }
}

/** Short-lived cache that keeps the last proven balance across transient failures. */
export class BalanceCache {
  private cached: UsageBalance | undefined
  private status: UsageBalanceStatus = 'no-key'
  private fetchedAt = 0
  private readonly refreshMs: number

  constructor(
    refreshMs: number = DEFAULT_BALANCE_REFRESH_MS,
    private readonly fetchBalance: () => Promise<{ balance?: UsageBalance, status: UsageBalanceStatus }> = fetchDeepSeekBalance,
    private readonly now: () => number = Date.now,
  ) {
    this.refreshMs = refreshMs > 0 ? refreshMs : DEFAULT_BALANCE_REFRESH_MS
  }

  async get(force = false): Promise<{
    readonly balance?: UsageBalance
    readonly status: UsageBalanceStatus
  }> {
    try {
      const age = this.now() - this.fetchedAt
      if (!force && this.fetchedAt > 0 && age >= 0 && age < this.refreshMs) {
        return {
          status: this.status,
          ...(this.cached === undefined ? {} : { balance: this.cached }),
        }
      }
      const next = await this.fetchBalance()
      this.fetchedAt = this.now()
      this.status = next.status
      if (next.balance !== undefined) {
        this.cached = next.balance
        return { status: 'ready', balance: next.balance }
      }
      if (this.cached !== undefined && next.status === 'unavailable') {
        this.status = 'unavailable'
        return { status: 'unavailable', balance: { ...this.cached, stale: true } }
      }
      this.cached = undefined
      return { status: next.status }
    } catch {
      if (this.cached !== undefined) {
        return { status: 'unavailable', balance: { ...this.cached, stale: true } }
      }
      return { status: 'unavailable' }
    }
  }
}

/** Client identity headers for Platform `getBalance` (mirrors AccountClientMetadata). */
export interface AccountClientMetadata {
  readonly version: string
  readonly locale: string
  readonly timezoneOffsetSeconds: number
}

export interface AccountWallet {
  readonly currency: 'CNY' | 'USD' | string
  readonly balance: string
}

export type AccountBalanceResult =
  | null
  | { readonly status: 'ready', readonly value: readonly AccountWallet[], readonly bonusWallets: readonly AccountWallet[] }
  | { readonly status: 'failed' }

/** Minimal DeepSeek account seam — Desktop owns the grant. */
export interface DeepSeekAccountBalance {
  getBalance(client: AccountClientMetadata): Promise<AccountBalanceResult>
}

function pickWallet(wallets: readonly AccountWallet[]): AccountWallet | undefined {
  return wallets.find(w => w.currency === 'CNY')
    ?? wallets.find(w => w.currency === 'USD')
    ?? wallets[0]
}

/** Map Platform wallet arrays into the same UsageBalance shape as `/user/balance`. */
export function parseAccountBalanceResult(
  result: AccountBalanceResult,
  now: number = Date.now(),
): ProviderBalanceSnapshot {
  if (result === null) {
    return { source: 'account', status: 'signed-out' }
  }
  if (result.status === 'failed') {
    return { source: 'account', status: 'unavailable' }
  }
  const recharge = pickWallet(result.value)
  if (recharge === undefined) {
    return { source: 'account', status: 'unavailable' }
  }
  const bonus = pickWallet(result.bonusWallets)
  const granted = moneyString(bonus?.balance ?? '0') ?? '0.00'
  const toppedUp = moneyString(recharge.balance)
  if (toppedUp === undefined) {
    return { source: 'account', status: 'unavailable' }
  }
  const totalNum = (Number.parseFloat(toppedUp) || 0) + (Number.parseFloat(granted) || 0)
  const total = totalNum.toFixed(2)
  return {
    source: 'account',
    status: 'ready',
    balance: {
      available: true,
      currency: recharge.currency,
      total,
      granted,
      toppedUp,
      checkedAt: now,
    },
  }
}

export async function fetchAccountBalance(options: {
  readonly account?: DeepSeekAccountBalance
  readonly client: AccountClientMetadata
  readonly now?: () => number
}): Promise<ProviderBalanceSnapshot> {
  try {
    const account = options.account
    if (account === undefined || typeof account.getBalance !== 'function') {
      return { source: 'account', status: 'signed-out' }
    }
    const result = await account.getBalance(options.client)
    return parseAccountBalanceResult(result, (options.now ?? Date.now)())
  } catch {
    return { source: 'account', status: 'unavailable' }
  }
}

function toApiKeySnapshot(
  result: { readonly balance?: UsageBalance, readonly status: UsageBalanceStatus },
): ProviderBalanceSnapshot {
  if (result.status === 'ready' && result.balance !== undefined) {
    return { source: 'api-key', status: 'ready', balance: result.balance }
  }
  if (result.status === 'no-key') return { source: 'api-key', status: 'no-key' }
  return {
    source: 'api-key',
    status: 'unavailable',
    ...(result.balance === undefined ? {} : { balance: result.balance }),
  }
}

function withStale(snapshot: ProviderBalanceSnapshot): ProviderBalanceSnapshot {
  if (snapshot.balance === undefined) return snapshot
  return { ...snapshot, balance: { ...snapshot.balance, stale: true } }
}

/** Cache both DeepSeek account and API-key balances independently. */
export class ProviderBalancesCache {
  private account: ProviderBalanceSnapshot = { source: 'account', status: 'signed-out' }
  private apiKey: ProviderBalanceSnapshot = { source: 'api-key', status: 'no-key' }
  private fetchedAt = 0
  private readonly refreshMs: number

  constructor(
    refreshMs: number = DEFAULT_BALANCE_REFRESH_MS,
    private readonly fetchAll: (force: boolean) => Promise<ProviderBalances>,
    private readonly now: () => number = Date.now,
  ) {
    this.refreshMs = refreshMs > 0 ? refreshMs : DEFAULT_BALANCE_REFRESH_MS
  }

  async get(force = false): Promise<ProviderBalances> {
    try {
      const age = this.now() - this.fetchedAt
      if (!force && this.fetchedAt > 0 && age >= 0 && age < this.refreshMs) {
        return { account: this.account, apiKey: this.apiKey }
      }
      const next = await this.fetchAll(force)
      this.fetchedAt = this.now()
      this.account = next.account.status === 'unavailable' && this.account.balance !== undefined
        && next.account.balance === undefined
        ? withStale({ ...this.account, status: 'unavailable' })
        : next.account
      this.apiKey = next.apiKey.status === 'unavailable' && this.apiKey.balance !== undefined
        && next.apiKey.balance === undefined
        ? withStale({ ...this.apiKey, status: 'unavailable' })
        : next.apiKey
      return { account: this.account, apiKey: this.apiKey }
    } catch {
      return {
        account: this.account.balance !== undefined
          ? withStale({ ...this.account, status: 'unavailable' })
          : { source: 'account', status: 'unavailable' },
        apiKey: this.apiKey.balance !== undefined
          ? withStale({ ...this.apiKey, status: 'unavailable' })
          : { source: 'api-key', status: 'unavailable' },
      }
    }
  }
}

export async function loadProviderBalances(options: {
  readonly credentials?: CredentialsResolver
  readonly account?: DeepSeekAccountBalance
  readonly client: AccountClientMetadata
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
  readonly fetchImpl?: typeof fetch
}): Promise<ProviderBalances> {
  const now = options.now ?? Date.now
  const [account, apiKeyRaw] = await Promise.all([
    fetchAccountBalance({
      account: options.account,
      client: options.client,
      now,
    }),
    fetchDeepSeekBalance({
      credentials: options.credentials,
      env: options.env,
      now,
      fetchImpl: options.fetchImpl,
    }),
  ])
  return {
    account,
    apiKey: toApiKeySnapshot(apiKeyRaw),
  }
}
