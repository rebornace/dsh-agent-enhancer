import { describe, expect, it } from 'vitest'
import { remoteInfo } from '../src/host/rpc.ts'
import { clientRemoteInfo } from '../src/client/remote.ts'

describe('update remotes', () => {
  it('registers checkUpdate and applyUpdate on host and client', () => {
    const hostMethods = remoteInfo.descriptors.map(d => d.method)
    expect(hostMethods).toEqual(expect.arrayContaining(['checkUpdate', 'applyUpdate']))
    const clientMethods = clientRemoteInfo.descriptors.map(d => d.method)
    expect(clientMethods).toEqual(expect.arrayContaining(['checkUpdate', 'applyUpdate']))
  })
})
