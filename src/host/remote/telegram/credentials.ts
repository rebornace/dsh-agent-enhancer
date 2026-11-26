import type { Context } from '@deepseek-ai/cordis'
import type { TelegramCredentials } from './transport.ts'

/** One secret ref holding the whole Telegram bot tuple as JSON. */
const CREDENTIAL_REF = 'DSH_AGENT_ENHANCER_TELEGRAM'

interface ResolvedLike {
  readonly value: string
}

interface CredentialProviderLike {
  resolve(ref: string): Promise<ResolvedLike | undefined>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

export interface TelegramCredentialStore {
  load(): Promise<TelegramCredentials | undefined>
  save(credentials: TelegramCredentials): Promise<void>
  clear(): Promise<void>
}

function parse(value: string): TelegramCredentials | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.token !== 'string' || record.token.trim() === '') return undefined
  return {
    token: record.token,
    ...(typeof record.botId === 'string' && record.botId !== '' ? { botId: record.botId } : {}),
    ...(typeof record.username === 'string' && record.username !== '' ? { username: record.username } : {}),
  }
}

function provider(ctx: Context): CredentialProviderLike | undefined {
  let service: unknown
  try {
    service = ctx.get('credentials')
  } catch {
    return undefined
  }
  if (service === undefined || service === null || typeof service !== 'object') return undefined
  const candidate = service as Partial<CredentialProviderLike>
  if (typeof candidate.resolve !== 'function' || typeof candidate.set !== 'function') return undefined
  return service as CredentialProviderLike
}

/** Token storage on the host's credential service; no plaintext fallback. */
export function createTelegramCredentialStore(ctx: Context): TelegramCredentialStore {
  if (provider(ctx) === undefined) {
    return {
      async load() {
        return undefined
      },
      async save() {
        throw new Error('宿主没有提供凭据服务，无法安全保存 Telegram Bot Token')
      },
      async clear() {},
    }
  }
  return {
    async load() {
      const resolved = await provider(ctx)?.resolve(CREDENTIAL_REF)
      if (resolved === undefined) return undefined
      return parse(resolved.value)
    },
    async save(credentials) {
      const service = provider(ctx)
      if (service === undefined) throw new Error('宿主没有提供凭据服务')
      const payload: Record<string, string> = { token: credentials.token }
      if (credentials.botId !== undefined) payload.botId = credentials.botId
      if (credentials.username !== undefined) payload.username = credentials.username
      await service.set(CREDENTIAL_REF, JSON.stringify(payload))
    },
    async clear() {
      await provider(ctx)?.unset(CREDENTIAL_REF)
    },
  }
}
