import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import {
  apply,
  CheckpointRollbackRemoteService,
  Config,
  checkpointHostContribution,
  hostContribution,
} from '../src/host/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

it('assembles the guarded rollback service beside the model Remote and disposes both contributions', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const unregister = vi.fn()
  const register = vi.fn(() => unregister)
  ctx.provide('llm', {} as never)
  ctx.provide('sessions', { get: vi.fn(), flush: vi.fn() } as never)
  ctx.provide('agents', { get: vi.fn() } as never)
  ctx.provide('sessionProjections', { stateOf: vi.fn(), snapshot: vi.fn() } as never)
  ctx.provide('agentDefaultModel', { currentSelection: vi.fn() } as never)
  ctx.provide('typert', { register } as never)

  apply(ctx, Config({ rollbackEnabled: false }))

  expect(register).toHaveBeenCalledWith(hostContribution)
  expect(register).toHaveBeenCalledWith(checkpointHostContribution)
  expect(ctx.checkpointRollback).toBeInstanceOf(CheckpointRollbackRemoteService)
  await ctx.fiber.dispose()
  expect(unregister).toHaveBeenCalledTimes(2)
})
