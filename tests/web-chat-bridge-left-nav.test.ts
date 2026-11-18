import { describe, expect, it, vi } from 'vitest'
import { createWebChatSectionGate } from '../src/client/web-chat-bridge/left-nav.ts'

describe('createWebChatSectionGate', () => {
  it('does not register until supported and enabled', () => {
    const register = vi.fn(() => vi.fn())
    const gate = createWebChatSectionGate(register)
    gate.setWanted(true)
    expect(register).not.toHaveBeenCalled()
    gate.markSupported()
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('does not register when disabled', () => {
    const register = vi.fn(() => vi.fn())
    const gate = createWebChatSectionGate(register)
    gate.markSupported()
    gate.setWanted(false)
    expect(register).not.toHaveBeenCalled()
  })

  it('unregisters on disable after enable', () => {
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    const gate = createWebChatSectionGate(register)
    gate.markSupported()
    gate.setWanted(true)
    gate.setWanted(false)
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('unregisters on retire', () => {
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    const gate = createWebChatSectionGate(register)
    gate.markSupported()
    gate.setWanted(true)
    gate.retire()
    expect(unregister).toHaveBeenCalledTimes(1)
  })
})
