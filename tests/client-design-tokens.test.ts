import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'

async function loadStyle(): Promise<{ css: string; rules: CSSStyleRule[] }> {
  const css = await readFile('src/client/styles.module.css', 'utf8')
  const dom = new JSDOM('<head></head>')
  const style = dom.window.document.createElement('style')
  style.textContent = css
  dom.window.document.head.append(style)
  const rules = Array.from(style.sheet?.cssRules ?? []).filter(
    (rule): rule is CSSStyleRule => rule instanceof dom.window.CSSStyleRule,
  )
  return { css, rules }
}

async function themeTokens(): Promise<Set<string>> {
  const raw = await readFile('tests/fixtures/dsh-theme-tokens.txt', 'utf8')
  return new Set(
    raw.split('\n').map(line => line.trim()).filter(line => line.startsWith('--dsw-')),
  )
}

it('only references design tokens the Desktop theme defines', async () => {
  const { css } = await loadStyle()
  const known = await themeTokens()
  const used = new Set(css.match(/--dsw-[a-z0-9-]+/g) ?? [])
  const unknown = [...used].filter(token => !known.has(token)).sort()
  // A var() naming a token that does not exist is dropped silently, so an
  // unknown name is always a real defect: the declaration never applies.
  expect(unknown).toEqual([])
})

it('paints the browser approval card on an opaque theme surface', async () => {
  const { rules } = await loadStyle()
  const known = await themeTokens()
  const banner = rules.find(rule => rule.selectorText.startsWith('.browserAgentBanner'))
  expect(banner).toBeDefined()
  const style = banner!.style
  const background = style.getPropertyValue('background')
  expect(background).toBe('var(--dsw-alias-bg-layer-1)')
  expect(known.has(background.replace(/^var\((.*)\)$/, '$1'))).toBe(true)
  // The reported bug: a fixed card over page content with no fill.
  expect(style.getPropertyValue('box-shadow')).toBe('var(--dsw-shadow-lv3)')
  expect(style.getPropertyValue('color')).toBe('var(--dsw-alias-label-primary)')
})
