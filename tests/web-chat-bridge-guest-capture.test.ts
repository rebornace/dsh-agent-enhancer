// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { captureFromDocument } from '../src/client/web-chat-bridge/capture.ts'
import { readWebChatGuestBrowseContext } from '../src/client/web-chat-bridge/guest-capture.ts'

const selectors = { turn: '[data-role]', roleAttr: 'data-role' }

describe('readWebChatGuestBrowseContext', () => {
  it('parses guest HTML from executeJavaScript and ignores contentDocument', async () => {
    const html = `<html><head><title>会话</title></head><body>
      <div data-role="user">问题</div>
      <div data-role="assistant">回答</div>
    </body></html>`
    const executeJavaScript = vi.fn(async (code: string) => ({
      code,
      href: 'https://chat.deepseek.com/a/chat/s/abc',
      html,
      generating: false,
      unsentDraft: false,
    }))
    const contentDocument = new DOMParser().parseFromString(
      '<div data-role="user">WRONG</div>',
      'text/html',
    )
    const context = await readWebChatGuestBrowseContext({
      executeJavaScript,
      contentDocument,
      getURL: () => 'https://chat.deepseek.com/',
      loadURL: () => undefined,
    } as never)
    expect(String(executeJavaScript.mock.calls[0]?.[0])).toContain('outerHTML')
    expect(context?.url).toBe('https://chat.deepseek.com/a/chat/s/abc')
    expect(context?.document).not.toBeNull()
    expect(context?.document).not.toBe(contentDocument)
    const transcript = captureFromDocument(context!.document!, {
      url: context!.url,
      selectors,
    })
    expect(transcript.turns.map(turn => turn.text)).toEqual(['问题', '回答'])
    expect(transcript.partial).toBe(true)
  })

  it('returns a null document when the guest script fails, even if contentDocument is set', async () => {
    const contentDocument = new DOMParser().parseFromString(
      '<div data-role="user">still wrong</div>',
      'text/html',
    )
    const context = await readWebChatGuestBrowseContext({
      executeJavaScript: async () => {
        throw new Error('guest unavailable')
      },
      contentDocument,
      src: 'https://chat.deepseek.com/',
      loadURL: () => undefined,
    } as never)
    expect(context?.document).toBeNull()
    expect(context?.url).toBe('https://chat.deepseek.com/')
  })

  it('forwards generating and unsent flags from the guest script', async () => {
    const context = await readWebChatGuestBrowseContext({
      executeJavaScript: async () => ({
        href: 'https://chat.deepseek.com/',
        html: '<html><body><div data-role="user">q</div></body></html>',
        generating: true,
        unsentDraft: true,
      }),
      loadURL: () => undefined,
    } as never)
    expect(context?.isGenerating).toBe(true)
    expect(context?.hasUnsentDraft).toBe(true)
  })
})
