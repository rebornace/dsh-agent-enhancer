import { describe, expect, it } from 'vitest'
import { extractPageLinksFromHtml } from './page-links.ts'

describe('extractPageLinksFromHtml', () => {
  it('extracts absolute and root-relative http links without site-specific ids', () => {
    const html = `
      <a href="/">home</a>
      <a href="/posts/42">post</a>
      <a href="https://cdn.example.com/x.js">asset</a>
      <a href="#top">skip</a>
    `
    const links = extractPageLinksFromHtml(html, 'https://example.com/')
    expect(links.some(l => l.href.includes('/posts/42'))).toBe(true)
    expect(links.every(l => !l.href.includes('#top'))).toBe(true)
  })

  it('harvests content URLs embedded in JSON when href= is missing', () => {
    const html = `<script>window.__DATA__={"url":"https://example.com/video/BV123","title":"hello"}</script>`
    const links = extractPageLinksFromHtml(html, 'https://example.com/')
    expect(links.some(l => l.href.includes('/video/BV123'))).toBe(true)
  })
})
