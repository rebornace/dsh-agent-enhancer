import { describe, expect, it } from 'vitest'
import { classifyMcpProbeFailure, rewriteMcpProbeFailure } from './probe-message.ts'

describe('classifyMcpProbeFailure', () => {
  it('detects ModelScope-style expired URL payloads', () => {
    expect(classifyMcpProbeFailure(
      'connect: SdkHttpError: Error POSTing to endpoint: {"error":{"message":"Url is expired"}}',
    )).toBe('url-expired')
  })

  it('keeps other failures generic', () => {
    expect(classifyMcpProbeFailure('connect: ECONNREFUSED')).toBe('generic')
  })
})

describe('rewriteMcpProbeFailure', () => {
  it('collapses expired URL to a stable code', () => {
    expect(rewriteMcpProbeFailure('Url is expired')).toBe('url-expired')
  })
})
