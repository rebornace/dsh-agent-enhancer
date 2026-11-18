import { describe, expect, it, vi } from 'vitest'
import { installMonacoRoute } from '../src/host/file-edit/monaco.ts'

describe('installMonacoRoute', () => {
  it('does not read undeclared ctx.connection (Cordis would kill the Host fiber)', () => {
    const warn = vi.fn()
    const get = vi.fn(() => {
      throw new Error('connection is not injected')
    })
    const ctx = new Proxy(
      { get, logger: { warn } },
      {
        get(target, prop, receiver) {
          if (prop === 'connection') {
            throw new Error('Cordis: service "connection" is not declared in inject')
          }
          return Reflect.get(target, prop, receiver)
        },
      },
    )

    expect(() => installMonacoRoute(ctx)).not.toThrow()
    expect(get).toHaveBeenCalledWith('connection')
    expect(warn).toHaveBeenCalled()
  })

  it('registers when connection.fetch.register is available via soft get', () => {
    const register = vi.fn()
    const warn = vi.fn()
    installMonacoRoute({
      logger: { warn },
      get(name) {
        if (name !== 'connection') return undefined
        return { fetch: { register } }
      },
    })
    expect(register).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })
})
