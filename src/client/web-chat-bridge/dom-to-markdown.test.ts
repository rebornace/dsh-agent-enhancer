/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { domToMarkdown, preserveVisibleText } from './dom-to-markdown.ts'

function el(html: string): Element {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
  return doc.getElementById('root')!
}

describe('domToMarkdown', () => {
  it('keeps fenced code, lists, and emphasis', () => {
    const markdown = domToMarkdown(el(`
      <p>Intro <strong>bold</strong> and <em>ital</em>.</p>
      <pre><code class="language-ts">const x = 1\n</code></pre>
      <ul><li>one</li><li>two</li></ul>
      <ol><li>first</li></ol>
    `))
    expect(markdown).toContain('**bold**')
    expect(markdown).toContain('*ital*')
    expect(markdown).toContain('```ts')
    expect(markdown).toContain('const x = 1')
    expect(markdown).toContain('- one')
    expect(markdown).toContain('- two')
    expect(markdown).toContain('1. first')
  })

  it('keeps paragraph breaks instead of one flattened line', () => {
    const markdown = domToMarkdown(el('<p>line one</p><p>line two</p>'))
    expect(markdown).toBe('line one\n\nline two')
  })

  it('renders simple links and tables', () => {
    const markdown = domToMarkdown(el(`
      <p><a href="https://example.com">ex</a></p>
      <table>
        <tr><th>A</th><th>B</th></tr>
        <tr><td>1</td><td>2</td></tr>
      </table>
    `))
    expect(markdown).toContain('[ex](https://example.com)')
    expect(markdown).toContain('| A | B |')
    expect(markdown).toContain('| 1 | 2 |')
  })
})

describe('preserveVisibleText', () => {
  it('keeps newlines while trimming runs of spaces', () => {
    expect(preserveVisibleText('a  \n\n  b\tc')).toBe('a\n\nb c')
  })
})
