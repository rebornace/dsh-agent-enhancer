// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { captureFromDocument } from '../src/client/web-chat-bridge/capture.ts'
import {
  DEEPSEEK_WEB_CHAT_CAPTURE_SELECTORS,
  DEEPSEEK_WEB_CHAT_CAPTURE_SELECTOR_PROFILES,
} from '../src/client/web-chat-bridge/capture-selectors.ts'
import { WEB_CHAT_MAX_MESSAGES, WEB_CHAT_MAX_TEXT_BYTES } from '../src/host/web-chat-bridge/limits.ts'

const selectors = { turn: '[data-role]', roleAttr: 'data-role' }

function docFromHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

describe('captureFromDocument', () => {
  it('reads visible user/assistant turns and marks partial', () => {
    const html = `
      <html><head><title>会话标题</title></head><body>
      <div data-testid="chat">
        <div data-role="user">问题 A</div>
        <div data-role="assistant">回答 A</div>
      </div></body></html>`
    const doc = docFromHtml(html)
    const t = captureFromDocument(doc, {
      url: 'https://chat.deepseek.com/a/chat/s/abc',
      selectors,
      now: () => '2026-11-09T07:00:00.000Z',
    })
    expect(t.partial).toBe(true)
    expect(t.turns.map((x) => x.role)).toEqual(['user', 'assistant'])
    expect(t.turns.map((x) => x.text)).toEqual(['问题 A', '回答 A'])
    expect(t.title).toBe('会话标题')
    expect(t.source.kind).toBe('rendered-capture')
    expect(t.source.url).toBe('https://chat.deepseek.com/a/chat/s/abc')
    expect(t.source.chatSessionId).toBe('abc')
    expect(t.source.capturedAt).toBe('2026-11-09T07:00:00.000Z')
  })

  it('throws when generating', () => {
    const doc = docFromHtml('<div></div>')
    expect(() => captureFromDocument(doc, {
      url: 'https://chat.deepseek.com/',
      selectors,
      isGenerating: () => true,
    })).toThrow(/generating/i)
  })

  it('throws when unsent draft', () => {
    const doc = docFromHtml('<div data-role="user">sent</div>')
    expect(() => captureFromDocument(doc, {
      url: 'https://chat.deepseek.com/a/chat/s/x',
      selectors,
      hasUnsentDraft: () => true,
    })).toThrow(/unsent|draft/i)
  })

  it('throws when no turns in page', () => {
    const doc = docFromHtml('<div></div>')
    expect(() => captureFromDocument(doc, {
      url: 'https://chat.deepseek.com/',
      selectors,
    })).toThrow(/no messages|capture-empty/i)
  })

  it('rejects more than max messages', () => {
    const body = Array.from({ length: WEB_CHAT_MAX_MESSAGES + 1 }, (_, i) =>
      `<div data-role="${i % 2 === 0 ? 'user' : 'assistant'}">t${i}</div>`).join('')
    const doc = docFromHtml(`<div>${body}</div>`)
    expect(() => captureFromDocument(doc, {
      url: 'https://chat.deepseek.com/',
      selectors,
    })).toThrow(/5000|message/i)
  })

  it('rejects when combined turn text exceeds byte limit', () => {
    const huge = 'x'.repeat(WEB_CHAT_MAX_TEXT_BYTES + 1)
    const doc = docFromHtml(`<div data-role="user">${huge}</div>`)
    expect(() => captureFromDocument(doc, {
      url: 'https://chat.deepseek.com/',
      selectors,
    })).toThrow(/too.?large|byte limit/i)
  })

  it('throws on empty turn selector instead of invalid querySelectorAll', () => {
    const doc = docFromHtml('<div data-role="user">hi</div>')
    expect(() => captureFromDocument(doc, {
      url: 'https://chat.deepseek.com/',
      selectors: { turn: '', roleAttr: 'data-role' },
    })).toThrow(/capture-selectors|turn selector/i)
  })

  it('default DeepSeek selectors are valid CSS and do not throw on query', () => {
    const doc = docFromHtml('<div></div>')
    expect(() => captureFromDocument(doc, {
      url: 'https://chat.deepseek.com/',
      selectors: DEEPSEEK_WEB_CHAT_CAPTURE_SELECTORS,
    })).toThrow(/no messages|capture-empty/i)
    expect(DEEPSEEK_WEB_CHAT_CAPTURE_SELECTORS.turn.trim()).not.toBe('')
  })

  it('normalizes human and model role aliases', () => {
    const doc = docFromHtml(`
      <div data-role="human">ask</div>
      <div data-role="model">reply</div>`)
    const t = captureFromDocument(doc, {
      url: 'https://chat.deepseek.com/',
      selectors,
    })
    expect(t.turns).toEqual([
      { role: 'user', text: 'ask' },
      { role: 'assistant', text: 'reply' },
    ])
  })

  it('falls back to data-role profile when ds-message rows are absent', () => {
    const doc = docFromHtml(`
      <div data-role="user">fallback user</div>
      <div data-role="assistant">fallback assistant</div>`)
    const t = captureFromDocument(doc, {
      url: 'https://chat.deepseek.com/s/x',
      profiles: DEEPSEEK_WEB_CHAT_CAPTURE_SELECTOR_PROFILES,
    })
    expect(t.turns.map(x => x.text)).toEqual(['fallback user', 'fallback assistant'])
  })

  it('reads ds-message rows with ancestor role wrappers', () => {
    const doc = docFromHtml(`
      <div class="_9663006">
        <div class="ds-message">
          <div class="ds-collapsible-text"><div><span>你好</span></div></div>
        </div>
      </div>
      <div class="_4f9bf79">
        <div class="ds-message">
          <div class="ds-assistant-message-main-content">回复</div>
        </div>
      </div>`)
    const t = captureFromDocument(doc, {
      url: 'https://chat.deepseek.com/s/y',
      profiles: [DEEPSEEK_WEB_CHAT_CAPTURE_SELECTOR_PROFILES[0]!],
    })
    expect(t.turns).toEqual([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '回复' },
    ])
  })

  it('keeps markdown structure from rendered assistant HTML instead of flattening', () => {
    const doc = docFromHtml(`
      <div class="_4f9bf79">
        <div class="ds-message">
          <div class="ds-assistant-message-main-content">
            <p>说明</p>
            <pre><code class="language-js">console.log(1)</code></pre>
            <ul><li>a</li><li>b</li></ul>
          </div>
        </div>
      </div>`)
    const t = captureFromDocument(doc, {
      url: 'https://chat.deepseek.com/s/styled',
      profiles: [DEEPSEEK_WEB_CHAT_CAPTURE_SELECTOR_PROFILES[0]!],
    })
    expect(t.turns).toHaveLength(1)
    const text = t.turns[0]!.text
    expect(text).toContain('说明')
    expect(text).toContain('```js')
    expect(text).toContain('console.log(1)')
    expect(text).toContain('- a')
    expect(text).toContain('- b')
    expect(text.includes('\n')).toBe(true)
  })

  it('prefers title selector over document.title', () => {
    const doc = docFromHtml(`
      <html><head><title>browser tab</title></head><body>
        <h1 data-chat-title>侧边栏标题</h1>
        <div data-role="user">one</div>
      </body></html>`)
    const t = captureFromDocument(doc, {
      url: 'https://chat.deepseek.com/',
      selectors: { ...selectors, title: '[data-chat-title]' },
    })
    expect(t.title).toBe('侧边栏标题')
  })
})
