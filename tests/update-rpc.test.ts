import { describe, expect, it } from 'vitest'
import { remoteInfo } from '../src/host/rpc.ts'
import { clientRemoteInfo } from '../src/client/remote.ts'

describe('agentEnhancer remotes', () => {
  it('does not register plugin self-update methods', () => {
    const hostMethods = remoteInfo.descriptors.map(d => d.method)
    const clientMethods = clientRemoteInfo.descriptors.map(d => d.method)
    expect(hostMethods).not.toContain('checkUpdate')
    expect(hostMethods).not.toContain('applyUpdate')
    expect(clientMethods).not.toContain('checkUpdate')
    expect(clientMethods).not.toContain('applyUpdate')
  })

  it('registers deleteSession on host and client', () => {
    const hostMethods = remoteInfo.descriptors.map(d => d.method)
    expect(hostMethods).toEqual(expect.arrayContaining(['deleteSession']))
    const clientMethods = clientRemoteInfo.descriptors.map(d => d.method)
    expect(clientMethods).toEqual(expect.arrayContaining(['deleteSession']))
  })

  it('registers getSkillInstallProgress on host and client', () => {
    const hostMethods = remoteInfo.descriptors.map(d => d.method)
    expect(hostMethods).toEqual(expect.arrayContaining(['getSkillInstallProgress']))
    const clientMethods = clientRemoteInfo.descriptors.map(d => d.method)
    expect(clientMethods).toEqual(expect.arrayContaining(['getSkillInstallProgress']))
  })

  it('registers browser-agent launch and related methods on host and client', () => {
    const needed = [
      'browserAgentSnapshot',
      'browserAgentResolve',
      'browserAgentResolveTabConflict',
      'browserAgentOpenUrl',
      'browserAgentQuotePage',
      'browserAgentLaunchBrowser',
      'browserAgentSetBrowser',
    ]
    const hostMethods = remoteInfo.descriptors.map(d => d.method)
    const clientMethods = clientRemoteInfo.descriptors.map(d => d.method)
    expect(hostMethods).toEqual(expect.arrayContaining(needed))
    expect(clientMethods).toEqual(expect.arrayContaining(needed))
  })
})
