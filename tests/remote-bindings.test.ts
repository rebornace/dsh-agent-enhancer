import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BindingStore } from '../src/host/remote/bindings.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bindings-'))
  dirs.push(dir)
  return join(dir, 'bindings.json')
}

describe('BindingStore', () => {
  it('binds, lists and unbinds chats', () => {
    const store = new BindingStore({ filePath: null, now: () => 100 })
    store.bind('chat-1', 'weixin')
    store.bind('chat-2', 'weixin')

    expect(store.isBound('chat-1')).toBe(true)
    expect(store.list()).toHaveLength(2)

    expect(store.unbind('chat-1')).toBe(true)
    expect(store.isBound('chat-1')).toBe(false)
    store.unbindAll()
    expect(store.list()).toHaveLength(0)
  })

  it('persists chat rows but never pairing codes', () => {
    const file = tempFile()
    const first = new BindingStore({ filePath: file, now: () => 10 })
    first.bind('chat-1', 'weixin')
    const { code } = first.issueCode()

    const raw = readFileSync(file, 'utf8')
    expect(raw).toContain('chat-1')
    expect(raw).not.toContain(code)

    const second = new BindingStore({ filePath: file, now: () => 20 })
    expect(second.isBound('chat-1')).toBe(true)
    expect(second.redeem(code, 'chat-2', 'weixin')).toBe(false)
  })

  it('redeems a code exactly once', () => {
    const store = new BindingStore({ filePath: null, now: () => 0 })
    const { code } = store.issueCode()

    expect(store.redeem(code, 'chat-1', 'weixin')).toBe(true)
    expect(store.isBound('chat-1')).toBe(true)
    expect(store.redeem(code, 'chat-2', 'weixin')).toBe(false)
  })

  it('rejects expired codes', () => {
    const clock = { now: 0 }
    const store = new BindingStore({ filePath: null, now: () => clock.now })
    const { code } = store.issueCode(100)
    clock.now = 200
    expect(store.redeem(code, 'chat-1', 'weixin')).toBe(false)
  })

  it('uses the injected code generator and avoids collisions', () => {
    const values = ['111111', '111111', '222222']
    let index = 0
    const store = new BindingStore({
      filePath: null,
      code: () => values[Math.min(index++, values.length - 1)] ?? '333333',
    })
    expect(store.issueCode().code).toBe('111111')
    expect(store.issueCode().code).toBe('222222')
  })

  it('persists the chat focus and clears it', () => {
    const file = tempFile()
    const first = new BindingStore({ filePath: file, now: () => 0 })
    first.bind('chat-1', 'weixin')
    first.setFocus('chat-1', 'session-1')

    const second = new BindingStore({ filePath: file })
    expect(second.binding('chat-1')?.focusSessionId).toBe('session-1')

    second.setFocus('chat-1', undefined)
    const third = new BindingStore({ filePath: file })
    expect(third.binding('chat-1')?.focusSessionId).toBeUndefined()

    // An unbound chat is not created just to hold a focus.
    third.setFocus('nope', 'session-1')
    expect(third.list()).toHaveLength(1)
  })

  it('keeps a pairing code scoped to its channel', () => {
    const store = new BindingStore({ filePath: null, now: () => 0, code: () => '246810' })
    const { code } = store.issueCode(1_000, 'weixin')
    expect(store.redeem(code, 'tg-chat', 'telegram')).toBe(false)
    expect(store.isBound('tg-chat')).toBe(false)
    // A wrong-channel attempt must not burn the code.
    expect(store.redeem(code, 'wx-chat', 'weixin')).toBe(true)
    expect(store.binding('wx-chat')?.channel).toBe('weixin')
  })

  it('ignores a corrupt file instead of throwing', () => {
    const file = tempFile()
    const store = new BindingStore({ filePath: file })
    store.bind('chat-1', 'weixin')
    rmSync(file, { force: true })
    const missing = new BindingStore({ filePath: file })
    expect(missing.list()).toHaveLength(0)
  })
})
