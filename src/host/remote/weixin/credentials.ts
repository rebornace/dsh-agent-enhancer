import type { Context } from '@deepseek-ai/cordis'
import type { WeixinCredentials } from './transport.ts'

/** One secret ref holding the whole login tuple as JSON; the host masks it in UIs. */
const CREDENTIAL_REF = 'DSH_AGENT_ENHANCER_WEIXIN'

interface ResolvedLike {
  readonly value: string
}

interface CredentialProviderLike {
  resolve(ref: string): Promise<ResolvedLike | undefined>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

export interface WeixinCredentialStore {
  load(): Promise<WeixinCredentials | undefined>
  save(credentials: WeixinCredentials): Promise<void>
  clear(): Promise<void>
}

function parse(value: string): WeixinCredentials | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.baseUrl !== 'string' || typeof record.token !== 'string') return undefined
  if (record.baseUrl === '' || record.token === '') return undefined
  return {
    baseUrl: record.baseUrl,
    token: record.token,
    ...(typeof record.botId === 'string' ? { botId: record.botId } : {}),
    ...(typeof record.userId === 'string' ? { userId: record.userId } : {}),
  }
}

function provider(ctx: Context): CredentialProviderLike | undefined {
  const service = ctx.get('credentials') as CredentialProviderLike | undefined
  if (service === undefined) return undefined
  if (typeof service.resolve !== 'function' || typeof service.set !== 'function') return undefined
  return service
}

/**
 * Token storage on the host's credential service.
 *
 * The whole tuple lives in one secret ref so a half-written login (new token,
 * old base URL) cannot exist. When the host has no credential service, the
 * caller gets a store that refuses writes and resolves nothing, rather than a
 * plaintext file nobody expects.
 */
export function createWeixinCredentialStore(ctx: Context): WeixinCredentialStore {
  if (provider(ctx) === undefined) {
    return {
      async load() {
        return undefined
      },
      async save() {
        throw new Error('宿主没有提供凭据服务，无法安全保存微信登录')
      },
      async clear() {},
    }
  }
  return {
    async load() {
      const service = provider(ctx)
      const resolved = await service?.resolve(CREDENTIAL_REF)
      if (resolved === undefined) return undefined
      return parse(resolved.value)
    },
    async save(credentials) {
      const service = provider(ctx)
      if (service === undefined) throw new Error('宿主没有提供凭据服务')
      const payload: Record<string, string> = { baseUrl: credentials.baseUrl, token: credentials.token }
      if (credentials.botId !== undefined) payload.botId = credentials.botId
      if (credentials.userId !== undefined) payload.userId = credentials.userId
      await service.set(CREDENTIAL_REF, JSON.stringify(payload))
    },
    async clear() {
      const service = provider(ctx)
      await service?.unset(CREDENTIAL_REF)
    },
  }
}
