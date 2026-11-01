import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, ComposerEnhancerService, Config, hostContribution, inject } from '../src/host/index.ts'
import { AuxiliaryError } from '../src/errors.ts'
import { AuxiliaryModels } from '../src/host/model.ts'
import { remoteInfo, rpcPayloadSchema } from '../src/host/rpc.ts'
import type { RpcPayload } from '../src/host/rpc.ts'

const contexts: Context[] = []

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

function payload(): RpcPayload {
  return rpcPayloadSchema.parse({
    method: 'generate',
    data: {
      operation: 'optimize',
      requestId: 'req-1',
      sessionId: 'session-1',
      source: '原稿',
      references: [],
      context: [],
    },
  })
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('composer configuration and Remote metadata', () => {
  it('defaults input helpers on and the independent rollback switch off', () => {
    const values = (input: unknown) => Object.fromEntries(Object.entries(input as Record<string, { get(): boolean }>)
      .map(([key, value]) => [key, value.get()]))
    expect(Config.dict!.historyEnabled?.meta.volatile).toBe(true)
    expect(Config.dict!.optimizeEnabled?.meta.volatile).toBe(true)
    expect(Config.dict!.predictEnabled?.meta.volatile).toBe(true)
    expect(Config.dict!.rollbackEnabled?.meta.volatile).toBe(true)
    expect(values(Config({}))).toEqual({
      historyEnabled: true,
      optimizeEnabled: true,
      predictEnabled: true,
      rollbackEnabled: false,
    })
    expect(values(Config({ historyEnabled: false, optimizeEnabled: false, predictEnabled: false, rollbackEnabled: false }))).toEqual({
      historyEnabled: false,
      optimizeEnabled: false,
      predictEnabled: false,
      rollbackEnabled: false,
    })
    expect(Object.keys(Config({}))).toEqual(['historyEnabled', 'optimizeEnabled', 'predictEnabled', 'rollbackEnabled'])
    expect(inject).toEqual(['llm', 'sessions', 'agents', 'sessionProjections', 'agentDefaultModel', 'fs', 'tools', 'typert', 'typertGateway'])
  })

  it('publishes one strict cancellable call with a nullable result', () => {
    expect(remoteInfo.package).toBe('dsh-composer-enhancer')
    expect(remoteInfo.descriptors).toHaveLength(1)
    expect(remoteInfo.descriptors[0]).toMatchObject({
      namespace: 'composerEnhancer',
      method: 'call',
      service: 'composerEnhancer',
      implementation: 'call',
      cancellation: { parameter: 'signal' },
    })
    expect(hostContribution).toEqual({
      package: 'dsh-composer-enhancer',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: remoteInfo.descriptors,
    })
    const method = remoteInfo.methods['composerEnhancer/call']!
    const parser = method.input({ strict: true }).create()
    const value = payload()
    expect(parser.parse({ payload: value })).toEqual({ payload: value })
    expect(method.result.create().parse(null)).toBeNull()
    expect(method.result.create().parse({
      requestId: 'req-1', text: '结果', route: { provider: 'deepseek', model: 'deepseek-chat' },
    })).toEqual({
      requestId: 'req-1', text: '结果', route: { provider: 'deepseek', model: 'deepseek-chat' },
    })
  })

  it('requires optimize references and accepts validated result segments', () => {
    const data = {
      operation: 'optimize',
      requestId: 'req-1',
      sessionId: 'session-1',
      source: '分析 @a.ts',
      references: [{ offset: 3, length: 5, text: '@a.ts' }],
      context: [],
    }
    expect(rpcPayloadSchema.parse({ method: 'generate', data })).toEqual({ method: 'generate', data })
    expect(() => rpcPayloadSchema.parse({
      method: 'generate',
      data: { ...data, references: undefined },
    })).toThrow()
    expect(() => rpcPayloadSchema.parse({
      method: 'generate',
      data: {
        operation: 'predict',
        requestId: 'req-predict',
        sessionId: 'session-1',
        references: data.references,
        context: [],
      },
    })).toThrow()
    const parser = remoteInfo.methods['composerEnhancer/call']!.result.create()
    const result = {
      requestId: 'req-1',
      text: '分析 @a.ts',
      segments: ['分析 ', '@a.ts'],
      route: { provider: 'deepseek', model: 'deepseek-chat' },
    }
    expect(parser.parse(result)).toEqual(result)
  })

  it.each([
    ['negative offset', { offset: -1, length: 5, text: '@a.ts' }],
    ['fractional offset', { offset: 1.5, length: 5, text: '@a.ts' }],
    ['zero length', { offset: 3, length: 0, text: '@a.ts' }],
    ['empty text', { offset: 3, length: 5, text: '' }],
    ['extra field', { offset: 3, length: 5, text: '@a.ts', extra: true }],
  ])('rejects a reference with %s', (_name, reference) => {
    const parsed = rpcPayloadSchema.safeParse({
      method: 'generate',
      data: {
        operation: 'optimize',
        requestId: 'req-1',
        sessionId: 'session-1',
        source: '分析 @a.ts',
        references: [reference],
        context: [],
      },
    })
    if (parsed.success) throw new Error('Expected reference validation to fail')
    expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.arrayContaining(['references', 0]) }),
    ]))
  })

  it.each([
    ['provider', { provider: 'other' }],
    ['model', { model: 'other' }],
    ['credentials', { apiKey: 'secret' }],
    ['extra payload field', { extra: true }],
  ])('rejects client-supplied %s', async (_name, extra) => {
    const value = payload()
    expect(() => rpcPayloadSchema.parse({
      ...value,
      data: { ...value.data, ...extra },
    })).toThrow()
    const parser = remoteInfo.methods['composerEnhancer/call']!.input({ strict: true }).create()
    expect(() => parser.parse({ payload: { ...value, data: { ...value.data, ...extra } } })).toThrow()
  })

  it('rejects methods and operations outside the fixed auxiliary vocabulary', () => {
    expect(() => rpcPayloadSchema.parse({ ...payload(), method: 'retry' })).toThrow()
    expect(() => rpcPayloadSchema.parse({
      ...payload(),
      data: { ...payload().data, operation: 'history' },
    })).toThrow()
  })
})

describe('ComposerEnhancerService', () => {
  it('allows only the desktop owner to generate', async () => {
    const ownerCtx = context()
    ownerCtx.provide('invocation', { peer: { principal: { kind: 'owner' } } } as never)
    const generate = vi.fn(async () => null)
    const owner = new ComposerEnhancerService(ownerCtx, { generate } as never)
    const request = payload()
    const signal = new AbortController().signal
    await expect(owner.call(request, signal)).resolves.toBeNull()
    expect(generate).toHaveBeenCalledWith(request.data, signal)

    const guestCtx = context()
    guestCtx.provide('invocation', { peer: { principal: { kind: 'guest' } } } as never)
    const guest = new ComposerEnhancerService(guestCtx, { generate } as never)
    await expect(guest.call(request, signal)).rejects.toMatchObject({
      code: 'composer-enhancer/forbidden',
      message: 'Only the desktop owner may use Composer Enhance',
    })
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('preserves auxiliary categories without exposing internal details', async () => {
    const ctx = context()
    ctx.provide('invocation', { peer: { principal: { kind: 'owner' } } } as never)
    const service = new ComposerEnhancerService(ctx, {
      generate: vi.fn(async () => { throw new AuxiliaryError('MODEL_UNAVAILABLE') }),
    } as never)
    const rejection = await service.call(payload(), new AbortController().signal).catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(RemoteError)
    expect(rejection).toMatchObject({
      code: 'composer-enhancer/failed',
      message: 'Composer Enhance request failed',
      details: { code: 'MODEL_UNAVAILABLE' },
    })
    expect((rejection as Error).message).not.toContain('provider credential')
  })

  it('maps ordinary errors to a sanitized model failure', async () => {
    const ctx = context()
    ctx.provide('invocation', { peer: { principal: { kind: 'owner' } } } as never)
    const service = new ComposerEnhancerService(ctx, {
      generate: vi.fn(async () => { throw new Error('provider credential and private text') }),
    } as never)
    const rejection = await service.call(payload(), new AbortController().signal).catch((error: unknown) => error)
    expect(rejection).toMatchObject({
      code: 'composer-enhancer/failed',
      message: 'Composer Enhance request failed',
      details: { code: 'MODEL_FAILED' },
    })
    expect((rejection as Error).message).not.toContain('provider credential')
  })

  it('preserves caller cancellation', async () => {
    const ctx = context()
    ctx.provide('invocation', { peer: { principal: { kind: 'owner' } } } as never)
    const controller = new AbortController()
    controller.abort()
    const service = new ComposerEnhancerService(ctx, {
      generate: vi.fn(async () => { throw controller.signal.reason }),
    } as never)
    await expect(service.call(payload(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('host composition', () => {
  it('registers the Remote contribution through the host effect and cleans it up', async () => {
    const ctx = context()
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    ctx.provide('llm', {} as never)
    ctx.provide('sessions', { get: vi.fn() } as never)
    ctx.provide('sessionProjections', { stateOf: vi.fn() } as never)
    ctx.provide('agentDefaultModel', { currentSelection: vi.fn() } as never)
    ctx.provide('typert', { register } as never)
    apply(ctx, Config({}))
    expect(register).toHaveBeenCalledWith(hostContribution)
    expect(ctx.composerEnhancer).toBeInstanceOf(ComposerEnhancerService)
    await ctx.fiber.dispose()
    expect(unregister).toHaveBeenCalledTimes(2)
  })

  it('constructs the single model entry used by the Remote service', () => {
    const ctx = context()
    const models = new AuxiliaryModels(ctx)
    const service = new ComposerEnhancerService(ctx, models)
    expect(service).toBeInstanceOf(ComposerEnhancerService)
  })
})
