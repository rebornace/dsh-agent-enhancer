import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
type Disposer = () => void | Promise<void>

interface ClientDefinition {
  id: string
  factory: (require: (id: string) => unknown) => {
    apply: (ctx: {
      effect: (setup: () => Disposer | Promise<Disposer>) => void
      plugin: () => Promise<{ dispose: () => Promise<void> }>
      remote: {
        $mount: () => Promise<Disposer>
        pluginInventory: { list: () => Promise<never> }
      }
      configForms: { get: () => object; whileServed: () => Disposer }
      locale: { register: () => Disposer; bind: () => (key: string) => string; getLocale: () => { active: string; locales: readonly unknown[]; revision: number } }
      slots: { inject: () => Disposer }
    }) => void
  }
}

it('installs and removes compiled CSS through the client effect', async () => {
  const dom = new JSDOM('<head></head>')
  let definition: ClientDefinition | undefined
  runInNewContext(await readFile('lib/client.js', 'utf8'), {
    document: dom.window.document,
    window: {
      __ModuleLoader__: {
        load(value: ClientDefinition) {
          definition = value
        },
      },
    },
  })
  if (definition === undefined) throw new Error('Client bundle did not register its module')
  expect(definition.id).toBe('dsh-agent-enhancer')

  const disposers: Array<Disposer | Promise<Disposer>> = []
  definition.factory((id: string) => id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(id)).apply({
    effect(setup) {
      disposers.push(setup())
    },
    plugin: async () => ({ dispose: async () => {} }),
    remote: {
      $mount: async () => () => {},
      pluginInventory: { list: async () => { throw new Error('inventory unavailable') } },
    },
    configForms: {
      get: () => ({ getSnapshot: () => ({ value: {} }), subscribe: () => () => {} }),
      whileServed: () => () => {},
    },
    locale: { register: () => () => {}, bind: () => (key: string) => key, getLocale: () => ({ active: 'en', locales: [], revision: 0 }) },
    slots: { inject: () => () => {} },
  })

  const style = dom.window.document.head.querySelector('style[data-dsh-agent-enhancer]')
  expect(style).not.toBeNull()
  expect(style?.textContent).toContain('position: relative')
  expect(disposers.length).toBeGreaterThan(3)
  const resolved = await Promise.all(disposers)
  await resolved[0]?.()
  expect(dom.window.document.head.querySelector('style[data-dsh-agent-enhancer]')).toBeNull()
  for (const dispose of resolved.slice(1)) await dispose()
})

it('aligns composer overlays with the input width', async () => {
  const dom = new JSDOM('<head></head>')
  const style = dom.window.document.createElement('style')
  style.textContent = await readFile('src/client/styles.module.css', 'utf8')
  dom.window.document.head.append(style)
  const rules = Array.from(style.sheet?.cssRules ?? [])

  for (const className of ['historyDialog', 'prediction', 'hints']) {
    const rule = rules.find(candidate => candidate instanceof dom.window.CSSStyleRule &&
      candidate.selectorText === `.${className}`)
    expect(rule, className).toBeDefined()
    const declaration = (rule as CSSStyleRule).style
    expect(declaration.getPropertyValue('left'), className).toBe('0px')
    expect(declaration.getPropertyValue('right'), className).toBe('0px')
    expect(declaration.getPropertyValue('width'), className).toBe('auto')
    expect(declaration.getPropertyValue('max-width'), className).toBe('none')
    expect(declaration.getPropertyValue('box-sizing'), className).toBe('border-box')
  }
})

it('keeps user message bubbles right-aligned like the native user row', async () => {
  const dom = new JSDOM('<head></head>')
  const style = dom.window.document.createElement('style')
  style.textContent = await readFile('src/client/styles.module.css', 'utf8')
  dom.window.document.head.append(style)
  const rules = Array.from(style.sheet?.cssRules ?? [])
  const row = rules.find(candidate => candidate instanceof dom.window.CSSStyleRule &&
    candidate.selectorText === '.userMessageRow') as CSSStyleRule | undefined
  expect(row).toBeDefined()
  expect(row!.style.getPropertyValue('align-items')).toBe('flex-end')
  expect(row!.style.getPropertyValue('flex-direction')).toBe('column')
})
