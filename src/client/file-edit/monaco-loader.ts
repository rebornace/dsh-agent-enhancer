import { MONACO_ROUTE } from '../../shared/monaco-route.ts'
import { monacoModulesForLanguage } from './language.ts'

const MONACO_BASE = `${MONACO_ROUTE}?file=vs`

declare global {
  interface Window {
    require?: {
      config(options: object): void
      (modules: string[], success: () => void, error?: () => void): void
    }
    monaco?: MonacoApi
    MonacoEnvironment?: { getWorker(_workerId: string, label: string): Worker }
  }
}

export interface MonacoEditorAction {
  run(): void | Promise<void>
}

export interface MonacoTextModel {
  getLanguageId(): string
}

export interface MonacoEditor {
  getValue(): string
  setValue(value: string): void
  getModel(): MonacoTextModel | null
  onDidChangeModelContent(listener: () => void): { dispose(): void }
  addCommand(keybinding: number, handler: () => void): string | null
  getAction(id: string): MonacoEditorAction | null
  focus(): void
  layout(): void
  dispose(): void
  updateOptions(options: object): void
  trigger(source: string, handlerId: string, payload?: unknown): void
}

export interface MonacoApi {
  editor: {
    create(host: HTMLElement, options: object): MonacoEditor
    setTheme(theme: string): void
    setModelLanguage(model: MonacoTextModel, languageId: string): void
  }
  KeyMod: { CtrlCmd: number; Shift: number }
  KeyCode: { KeyS: number; KeyF: number }
}

let monacoLoading: Promise<MonacoApi> | null = null

function monacoUnavailable(): Error {
  return new Error('monaco unavailable')
}

function fetchMonaco(url: string, expectJs: boolean): Promise<string> {
  return fetch(url, { credentials: 'same-origin' }).then(res => {
    if (!res.ok) throw monacoUnavailable()
    if (expectJs) {
      const type = res.headers.get('content-type') || ''
      if (!type.includes('javascript') && !type.includes('ecmascript')) {
        // Some hosts omit content-type; still accept on 200 for .js paths.
        if (!url.includes('.js') && !url.includes('loader')) throw monacoUnavailable()
      }
    }
    return res.text()
  })
}

function loadScriptText(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
    const el = document.createElement('script')
    let done = false
    const timeout = setTimeout(fail, 15000)
    function clean() {
      clearTimeout(timeout)
      el.onload = null
      el.onerror = null
      try {
        URL.revokeObjectURL(url)
      } catch { /* ignore */ }
    }
    function fail() {
      if (done) return
      done = true
      clean()
      try {
        el.remove()
      } catch { /* ignore */ }
      reject(monacoUnavailable())
    }
    el.async = true
    el.src = url
    el.onload = () => {
      if (done) return
      done = true
      clean()
      resolve()
    }
    el.onerror = fail
    ;(document.head || document.getElementsByTagName('head')[0]).appendChild(el)
  })
}

function monacoFileFromUrl(src: string): string {
  const marker = '?file='
  const at = String(src).indexOf(marker)
  if (at < 0) throw monacoUnavailable()
  let file = String(src).slice(at + marker.length)
  const cut = file.search(/[&#]/)
  if (cut >= 0) file = file.slice(0, cut)
  try {
    file = decodeURIComponent(file)
  } catch {
    throw monacoUnavailable()
  }
  if (!file || file.includes('..') || file.includes('\\') || file.includes('\0') || file.startsWith('/')) {
    throw monacoUnavailable()
  }
  if (!/\.(js|css|ttf|json)$/i.test(file)) file += '.js'
  return file
}

function installMonacoScriptBridge(): void {
  const installed = Reflect.get(installMonacoScriptBridge, 'done') === true
  if (installed) return
  const head = document.head || document.getElementsByTagName('head')[0]
  if (!head?.appendChild) return
  Reflect.set(installMonacoScriptBridge, 'done', true)
  const orig = head.appendChild.bind(head)
  head.appendChild = function (node: Node) {
    const element = node as HTMLScriptElement
    const src = element?.getAttribute?.('src') || ''
    if (
      !element
      || String(element.tagName || '').toUpperCase() !== 'SCRIPT'
      || !src.startsWith(`${MONACO_ROUTE}?file=`)
    ) {
      return orig(node)
    }
    let file: string
    try {
      file = monacoFileFromUrl(src)
    } catch {
      try {
        element.dispatchEvent(new Event('error'))
      } catch { /* ignore */ }
      return node
    }
    fetchMonaco(`${MONACO_ROUTE}?file=${file}`, true)
      .then(text => {
        const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
        const drop = () => {
          try {
            URL.revokeObjectURL(blobUrl)
          } catch { /* ignore */ }
        }
        element.addEventListener('load', drop)
        element.addEventListener('error', drop)
        element.setAttribute('src', blobUrl)
        orig(node)
      })
      .catch(() => {
        try {
          element.dispatchEvent(new Event('error'))
        } catch { /* ignore */ }
      })
    return node
  } as typeof head.appendChild
}

function rewriteMonacoCss(css: string): string {
  const base = ['vs', 'editor']
  return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, _quote, raw) => {
    const value = String(raw).trim()
    if (!value || /^(?:data:|https?:|blob:|#|\/)/i.test(value)) return full
    const parts = base.slice()
    for (const piece of value.split('/')) {
      if (!piece || piece === '.') continue
      if (piece === '..') parts.pop()
      else parts.push(piece)
    }
    if (!parts.length || parts[0] !== 'vs' || parts.includes('..')) return full
    return `url("${MONACO_ROUTE}?file=${parts.join('/')}")`
  })
}

function injectMonacoCss(css: string): void {
  const id = 'agent-enhancer-monaco-css'
  const text = rewriteMonacoCss(css)
  const existing = document.getElementById(id)
  if (existing) {
    existing.textContent = text
    return
  }
  const style = document.createElement('style')
  style.id = id
  style.textContent = text
  ;(document.head || document.getElementsByTagName('head')[0]).appendChild(style)
}

function installMonacoWorkers(): void {
  const base = `${MONACO_ROUTE}?file=`
  const workerFile = `${base}vs/base/worker/workerMain.js`
  window.MonacoEnvironment = {
    getWorker(_workerId, label) {
      // workerMain routes json/css/html/ts labels when baseUrl points at /vs.
      const source = [
        `globalThis.MonacoEnvironment={baseUrl:${JSON.stringify(base)}};`,
        `globalThis.MonacoEnvironment.getWorkerUrl=function(){return ${JSON.stringify(workerFile)};};`,
        `importScripts(${JSON.stringify(workerFile)});`,
      ].join('')
      return new Worker(
        URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
        { name: label || 'monaco' },
      )
    },
  }
}

function requireModules(modules: readonly string[]): Promise<boolean> {
  if (modules.length === 0) return Promise.resolve(true)
  return new Promise(resolve => {
    try {
      if (window.require === undefined) {
        resolve(false)
        return
      }
      window.require(
        [...modules],
        () => resolve(true),
        () => resolve(false),
      )
    } catch {
      resolve(false)
    }
  })
}

const loadedLanguageModules = new Set<string>()

/** Ensure Monarch / language-mode AMD modules for `languageId` are registered. */
export async function ensureMonacoLanguage(languageId: string): Promise<void> {
  const modules = monacoModulesForLanguage(languageId).filter(mod => !loadedLanguageModules.has(mod))
  if (modules.length === 0) return
  // Load one-by-one so a missing optional mode (tsMode) does not skip the Monarch tokenizer.
  for (const mod of modules) {
    const ok = await requireModules([mod])
    if (ok) loadedLanguageModules.add(mod)
  }
}

function requireEditorMain(): Promise<MonacoApi> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(monacoUnavailable())
    }, 15000)
    const finish = (error: Error | null, value?: MonacoApi) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(value!)
    }
    try {
      window.require?.(
        ['vs/editor/editor.main'],
        () => {
          if (!window.monaco?.editor) finish(monacoUnavailable())
          else finish(null, window.monaco)
        },
        () => finish(monacoUnavailable()),
      )
    } catch (error) {
      finish(error instanceof Error ? error : monacoUnavailable())
    }
  })
}

async function loadLocalMonaco(): Promise<MonacoApi> {
  installMonacoWorkers()
  const loader = await fetchMonaco(`${MONACO_BASE}/loader.js`, true)
  await loadScriptText(loader)
  if (!window.require || typeof window.require.config !== 'function') throw monacoUnavailable()
  window.require.config({ paths: { vs: MONACO_BASE }, 'vs/css': { disabled: true } })
  installMonacoScriptBridge()
  const css = await fetchMonaco(`${MONACO_BASE}/editor/editor.main.css`, false)
  injectMonacoCss(css)
  return requireEditorMain()
}

export function ensureMonaco(): Promise<MonacoApi> {
  if (window.monaco?.editor) return Promise.resolve(window.monaco)
  if (monacoLoading) return monacoLoading
  monacoLoading = Promise.resolve()
    .then(loadLocalMonaco)
    .catch(error => {
      monacoLoading = null
      throw error
    })
  return monacoLoading
}

export function isDarkTheme(): boolean {
  try {
    return (
      document.body.hasAttribute('data-ds-dark-theme')
      || document.documentElement.dataset.theme === 'dark'
    )
  } catch {
    return false
  }
}
