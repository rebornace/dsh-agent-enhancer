import { describe, expect, it } from 'vitest'
import { disabledMcpStatus, summarizeMcpConnectionStatus } from './status.ts'

describe('summarizeMcpConnectionStatus', () => {
  it('maps missing status to unmounted', () => {
    expect(summarizeMcpConnectionStatus(undefined)).toEqual({
      state: 'unmounted',
      detail: null,
      toolCount: null,
    })
  })

  it('maps connected with tool count', () => {
    expect(summarizeMcpConnectionStatus({
      state: 'connected',
      toolCount: 3,
      connectedAt: 1,
    })).toEqual({
      state: 'connected',
      detail: null,
      toolCount: 3,
    })
  })

  it('maps failed with reason and error', () => {
    expect(summarizeMcpConnectionStatus({
      state: 'failed',
      reason: 'gave-up',
      lastError: 'boom',
    })).toEqual({
      state: 'failed',
      detail: 'gave-up: boom',
      toolCount: null,
    })
  })

  it('exposes disabled helper', () => {
    expect(disabledMcpStatus().state).toBe('disabled')
  })
})
