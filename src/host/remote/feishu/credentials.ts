import type { Context } from '@deepseek-ai/cordis'
import type { FeishuCredentials } from './transport.ts'

/** One secret ref holding the whole Feishu app tuple as JSON. */
const CREDENTIAL_REF = 'DSH_AGENT_ENHANCER_FEISHU'

interface ResolvedLike {
  readonly value: string
}

interface CredentialProviderLike {
  resolve(ref: string): Promise<ResolvedLike | undefined>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

export interface FeishuCredentialStore {
  load(): Promise<FeishuCredentials | undefined>
  save(credentials: FeishuCredentials): Promise<void>
  clear(): Promise<void>
}

function parse(value: string): FeishuCredentials | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.appId !== 'string' || record.appId.trim() === '') return undefined
  if (typeof record.appSecret !== 'string' || record.appSecret.trim() === '') return undefined
  return {
    appId: record.appId,
    appSecret: record.appSecret,
    ...(typeof record.name === 'string' && record.name !== '' ? { name: record.name } : {}),
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

/** App ID + secret storage on the host's credential service; no plaintext fallback. */
export function createFeishuCredentialStore(ctx: Context): FeishuCredentialStore {
  if (provider(ctx) === undefined) {
    return {
      async load() {
        return undefined
      },
      async save() {
        throw new Error('宿主没有提供凭据服务，无法安全保存飞书 App Secret')
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
      const payload: Record<string, string> = {
        appId: credentials.appId,
        appSecret: credentials.appSecret,
      }
      if (credentials.name !== undefined) payload.name = credentials.name
      await service.set(CREDENTIAL_REF, JSON.stringify(payload))
    },
    async clear() {
      await provider(ctx)?.unset(CREDENTIAL_REF)
    },
  }
}
