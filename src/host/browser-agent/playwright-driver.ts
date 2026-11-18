/**
 * Playwright-core driver for Desktop Browser Agent (sole shipping path).
 */

import { existsSync, mkdirSync } from 'node:fs'
import type { BrowserContext, Page } from 'playwright-core'
import type {
  BrowserActResult,
  BrowserDriver,
  BrowserDriverStatus,
  EmulateResult,
} from './driver.ts'
import {
  BROWSER_AGENT_PROFILE_SLOTS,
  browserAgentProfileDirFor,
  browserAgentProfileSlotDir,
  playwrightChannelOrder,
  playwrightChannelSatisfiesPreference,
  resolveBrowserExecutable,
  stopAgentBrowserProcesses,
  type BrowserPreference,
  type PlaywrightChannel,
} from './launch.ts'
import type {
  ExtractBody,
  SnapshotBody,
  StatusBody,
  TabListBody,
} from './protocol.ts'
import {
  capturePlaywrightSnapshot,
  PLAYWRIGHT_DRIVER_VERSION,
  PLAYWRIGHT_REF_ATTR,
  type PlaywrightRefRecord,
} from './playwright-snapshot.ts'
import {
  DEMO_RECORDER_SOURCE,
  DEMO_STOP_SOURCE,
  mergeDemoSteps,
  pushDemoStep,
  sanitizeDemoSteps,
  type DemoStep,
} from './demo.ts'
import { CaptureBuffer, redactText, redactUrl, type CaptureEntry, type CaptureKind } from './capture.ts'
import { pathsDiffer } from './auto-nav.ts'
import { TabRegistry } from './tab-registry.ts'

type PlaywrightModule = typeof import('playwright-core')

let playwrightModule: PlaywrightModule | null = null

/**
 * Load playwright-core on first launch rather than at plugin import.
 * A static import made every Desktop boot pay ~350 ms of module evaluation,
 * even with the browser feature switched off. See
 * docs/architecture/browser-agent-browse-parity.md (D6).
 */
async function loadPlaywright(): Promise<PlaywrightModule> {
  playwrightModule ??= await import('playwright-core')
  return playwrightModule
}

export interface PlaywrightDriverOptions {
  /** Static dir, or live getter so Chrome↔Edge switches pick the right profile. */
  readonly profileDir: string | (() => string)
  /** Static preference, or live getter so ensureReady always honors current settings. */
  readonly preference?: BrowserPreference | (() => BrowserPreference)
  /** Plugin data root — used to kill leftover processes across preference slots. */
  readonly profileRoot?: string
  /** Tests may set true; product default is headed for real login UX. */
  readonly headless?: boolean
}

export class PlaywrightDriver implements BrowserDriver {
  readonly kind = 'playwright' as const
  private readonly profileDirOption: string | (() => string)
  private readonly preferenceOption: BrowserPreference | (() => BrowserPreference)
  private readonly profileRoot: string | undefined
  private readonly headless: boolean
  private context: BrowserContext | null = null
  private page: Page | null = null
  private lastError: string | null = null
  private channel: PlaywrightChannel | null = null
  private launchedProfileDir: string | null = null
  private readonly tabs = new TabRegistry<PlaywrightRefRecord>()
  private readonly trackedPages = new WeakSet<Page>()
  /** Monotonic per-driver ref counter, so refs never collide across tabs. */
  private nextRef = 1
  /** Null until the debug tools ask for capture; stays on for the driver lifetime. */
  private capture: CaptureBuffer | null = null
  private readonly captureStartedPages = new WeakSet<Page>()
  private readonly requestStart = new WeakMap<object, number>()
  /** Last applied emulation per tab, echoed in snapshot so the agent can see it. */
  private readonly emulationByTab = new Map<number, {
    colorScheme?: string
    reducedMotion?: string
    viewport?: { readonly width: number; readonly height: number }
  }>()
  /** Active "show me" recording: bound page plus navigations seen meanwhile. */
  private demoPage: Page | null = null
  private demoNavSteps: DemoStep[] = []
  private demoPageSteps: DemoStep[] = []
  private demoTrackedPages = new WeakSet<Page>()
  private demoPageHandler: ((page: Page) => void) | null = null
  private demoBindingReady = false
  /** Last agent/UI use per page; a page's clock starts when it is first seen. */
  private readonly lastUse = new WeakMap<Page, number>()

  constructor(options: PlaywrightDriverOptions) {
    this.profileDirOption = options.profileDir
    this.preferenceOption = options.preference ?? 'auto'
    this.profileRoot = options.profileRoot
    this.headless = options.headless === true
  }

  private currentPreference(): BrowserPreference {
    return typeof this.preferenceOption === 'function' ? this.preferenceOption() : this.preferenceOption
  }

  private currentProfileDir(): string {
    return typeof this.profileDirOption === 'function' ? this.profileDirOption() : this.profileDirOption
  }

  /** Resolve the on-disk profile for a preference (+ auto channel isolation). */
  private profileDirFor(
    preference: BrowserPreference,
    channel?: PlaywrightChannel,
  ): string {
    if (this.profileRoot !== undefined) {
      return browserAgentProfileDirFor(this.profileRoot, preference, channel)
    }
    return this.currentProfileDir()
  }

  /**
   * Stable id for a page, and the place its refs live. Ids survive other tabs
   * opening/closing and are never reused; refs stay with the tab that captured
   * them, so switching tabs no longer invalidates the snapshot you came from.
   */
  private tabIdFor(page: Page): number {
    const tabId = this.tabs.idOf(page)
    if (!this.lastUse.has(page)) this.lastUse.set(page, Date.now())
    if (!this.trackedPages.has(page)) {
      this.trackedPages.add(page)
      page.on('close', () => {
        this.tabs.release(page)
        this.emulationByTab.delete(tabId)
        this.trackedPages.delete(page)
      })
    }
    return tabId
  }

  private clearRefs(page: Page): void {
    this.tabs.clearRefs(this.tabIdFor(page))
  }

  /** Any real use of a page resets its idle clock; sidebar listing does not. */
  private touch(page: Page): void {
    this.lastUse.set(page, Date.now())
  }

  async sweepIdleTabs(input: {
    readonly idleMs: number
    readonly keep?: readonly number[]
  }): Promise<readonly number[]> {
    const context = this.context
    if (context === null) return []
    const keep = new Set(input.keep ?? [])
    const pages = context.pages()
    const closed: number[] = []
    const now = Date.now()
    for (const page of pages) {
      // Keep at least one tab alive: closing it would quit the dedicated browser.
      if (pages.length - closed.length <= 1) break
      if (page === this.page || page.isClosed()) continue
      const tabId = this.tabIdFor(page)
      if (keep.has(tabId)) continue
      const last = this.lastUse.get(page) ?? now
      if (now - last < input.idleMs) continue
      await page.close().catch(() => undefined)
      if (page.isClosed()) closed.push(tabId)
    }
    return closed
  }

  /** Page still attached to this context and not closed. */
  private isLivePage(page: unknown): page is Page {
    if (page === null || typeof page !== 'object') return false
    const candidate = page as Page
    if (typeof candidate.isClosed !== 'function' || candidate.isClosed()) return false
    return this.context?.pages().includes(candidate) === true
  }

  status(): BrowserDriverStatus {
    const ready = this.context !== null && this.page !== null && !this.page.isClosed()
    const preference = this.currentPreference()
    return {
      kind: 'playwright',
      ready,
      listening: this.context !== null,
      lastError: this.lastError,
      endpoint: this.channel !== null
        ? `playwright:${this.channel}`
        : `playwright:unlaunched:${preference}`,
    }
  }

  async ensureReady(startUrl?: string): Promise<void> {
    const preference = this.currentPreference()
    const order = [...playwrightChannelOrder(preference, process.platform)]
    // Keep a successful auto fallback (e.g. Chrome after WebKit miss). Requiring
    // only the first channel caused open/close flaps on every Agent tool call.
    const runningOk = this.context !== null
      && this.page !== null
      && !this.page.isClosed()
      && playwrightChannelSatisfiesPreference(this.channel, preference, process.platform)
      && this.launchedProfileDir !== null
      && this.channel !== null
      && this.launchedProfileDir === this.profileDirFor(preference, this.channel)

    if (runningOk) {
      if (typeof startUrl === 'string' && /^https?:\/\//i.test(startUrl)) {
        const current = this.page!.url()
        if (current === 'about:blank' || current === '') {
          await this.page!.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
        }
      }
      return
    }

    // Preference / profile changed, or previous window closed — tear down before relaunch.
    if (this.context !== null) {
      await this.dispose().catch(() => undefined)
    }
    this.stopPreferenceProfiles(this.profileDirFor(preference))

    let lastDetail = ''
    for (const channel of order) {
      const profileDir = this.profileDirFor(preference, channel)
      mkdirSync(profileDir, { recursive: true })
      // Only kill siblings / stale holders of THIS channel profile — never the
      // other auto-* slot we may fall back to in the same ensureReady pass.
      stopAgentBrowserProcesses(profileDir)
      try {
        const context = channel === 'webkit'
          ? await this.launchWebkit(profileDir, preference)
          : await this.launchChromium(profileDir, preference, channel)
        if (context === null) {
          lastDetail = this.lastError ?? `${channel} is not available`
          continue
        }
        this.context = context
        this.channel = channel
        this.launchedProfileDir = profileDir
        this.lastError = null
        this.page = context.pages()[0] ?? await context.newPage()
        if (typeof startUrl === 'string' && /^https?:\/\//i.test(startUrl)) {
          await this.page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
        }
        context.on('close', () => {
          this.context = null
          this.page = null
          this.launchedProfileDir = null
          this.capture = null
        })
        return
      } catch (error) {
        lastDetail = error instanceof Error ? error.message : String(error)
        this.lastError = lastDetail
      }
    }
    const hint = preference === 'chrome' || preference === 'edge' || preference === 'safari'
      ? ` Preference is locked to ${preference} (no silent fallback).`
      : ''
    throw new Error(
      `Playwright could not launch a persistent browser (tried ${order.join(', ')}): ${lastDetail}.${hint}`,
    )
  }

  /**
   * Safari preference uses Playwright WebKit (Safari engine). Branded Safari.app
   * cannot be driven by Playwright; require system Safari to be present as a
   * platform gate, then launch the WebKit automation build.
   */
  private async launchWebkit(
    profileDir: string,
    preference: BrowserPreference,
  ): Promise<BrowserContext | null> {
    if (preference === 'safari') {
      const safari = resolveBrowserExecutable('safari', {
        platform: process.platform,
      })
      if (safari === null) {
        this.lastError = 'Safari is not installed'
        return null
      }
    }
    let webkitExe: string
    const { webkit } = await loadPlaywright()
    try {
      webkitExe = webkit.executablePath()
    } catch (error) {
      this.lastError = error instanceof Error
        ? error.message
        : 'Playwright WebKit is unavailable'
      return null
    }
    if (!existsSync(webkitExe)) {
      // Stable token for client locale mapping (Mac Safari / Auto WebKit).
      this.lastError =
        'WEBKIT_MISSING: Playwright WebKit is not installed. Run: npx playwright install webkit'
      return null
    }
    return webkit.launchPersistentContext(profileDir, {
      headless: this.headless,
      viewport: this.headless ? { width: 1280, height: 800 } : null,
    })
  }

  private async launchChromium(
    profileDir: string,
    preference: BrowserPreference,
    channel: Exclude<PlaywrightChannel, 'webkit'>,
  ): Promise<BrowserContext | null> {
    const kind = channel === 'msedge' ? 'edge' : 'chrome'
    // Prefer explicit exe so channel name never silently picks the wrong browser.
    const resolved = resolveBrowserExecutable(kind)
    if (preference === 'chrome' || preference === 'edge') {
      if (resolved === null || resolved.kind !== preference) {
        this.lastError = `${preference} is not installed or not found on PATH`
        return null
      }
    } else if (resolved === null) {
      this.lastError = `${kind} is not installed or not found on PATH`
      return null
    }

    const { chromium } = await loadPlaywright()
    return chromium.launchPersistentContext(profileDir, {
      executablePath: resolved!.executable,
      headless: this.headless,
      // Avoid Edge/Chrome infobar: "unsupported command-line flag: --no-sandbox".
      chromiumSandbox: true,
      ignoreDefaultArgs: ['--no-sandbox'],
      viewport: this.headless ? { width: 1280, height: 800 } : null,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-default-apps'],
    })
  }

  private stopPreferenceProfiles(activeProfileDir: string): void {
    stopAgentBrowserProcesses(activeProfileDir)
    if (this.launchedProfileDir !== null && this.launchedProfileDir !== activeProfileDir) {
      stopAgentBrowserProcesses(this.launchedProfileDir)
    }
    if (this.profileRoot !== undefined) {
      for (const slot of BROWSER_AGENT_PROFILE_SLOTS) {
        const dir = browserAgentProfileSlotDir(this.profileRoot, slot)
        if (dir !== activeProfileDir) stopAgentBrowserProcesses(dir)
      }
    }
  }

  private async requirePage(): Promise<Page> {
    await this.ensureReady()
    if (this.page === null || this.page.isClosed()) {
      throw new Error('Playwright page is not available')
    }
    this.touch(this.page)
    return this.page
  }

  async pageStatus(): Promise<StatusBody> {
    const page = await this.requirePage()
    return {
      connected: true,
      url: page.url(),
      title: await page.title().catch(() => ''),
      tabId: this.tabIdFor(page),
      bound: true,
    }
  }

  async navigate(
    url: string,
    options: { readonly newTab?: boolean } = {},
  ): Promise<{ readonly url: string; readonly title: string; readonly tabId?: number }> {
    await this.ensureReady()
    const context = this.context
    if (context === null) throw new Error('Playwright context is not available')

    let page = this.page
    if (options.newTab === true || page === null || page.isClosed()) {
      page = await context.newPage()
      this.page = page
    }

    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await settlePage(page)
    this.touch(page)
    this.clearRefs(page)
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      tabId: this.tabIdFor(page),
    }
  }

  async snapshot(): Promise<SnapshotBody> {
    const page = await this.requirePage()
    const tabId = this.tabIdFor(page)
    const { body, refs } = await capturePlaywrightSnapshot(page, { startRef: this.nextRef })
    this.nextRef += body.nodes.length
    // Refs belong to this tab only; other tabs keep theirs.
    this.tabs.setRefs(tabId, refs)
    const emulation = this.emulationByTab.get(tabId)
    return { ...body, ...(emulation === undefined ? {} : { emulation }), tabId }
  }

  async extract(input: { readonly focus?: string; readonly maxChars?: number } = {}): Promise<ExtractBody> {
    const page = await this.requirePage()
    const maxChars = Math.min(Math.max(input.maxChars ?? 8_000, 500), 50_000)
    const text = await page.locator('main, article, [role="main"], body').first().innerText().catch(() => '')
    const clipped = text.replace(/\s+/g, ' ').trim()
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      text: clipped.slice(0, maxChars),
      truncated: clipped.length > maxChars,
      ...(input.focus === undefined || input.focus.trim() === '' ? {} : { focus: input.focus.trim() }),
      tabId: this.tabIdFor(page),
    }
  }

  async click(ref: number): Promise<BrowserActResult> {
    const page = await this.requirePage()
    const tabId = this.tabIdFor(page)
    const record = this.tabs.ref(tabId, ref)
    if (record === undefined) {
      throw new Error(this.tabs.unknownRefMessage(ref, tabId))
    }
    const beforeUrl = page.url()
    const href = /^https?:\/\//i.test(record.href) ? record.href : ''
    const locator = page.locator(`[${PLAYWRIGHT_REF_ATTR}="${ref}"]`).first()
    const count = await locator.count().catch(() => 0)
    if (count === 0) {
      // Fallback: click by last known coordinates from snapshot.
      return this.clickAtPoint(page, beforeUrl, href, record)
    }

    const context = page.context()
    const popupWait = context.waitForEvent('page', { timeout: 5_000 }).catch(() => null)

    await locator.hover({ timeout: 3_000 }).catch(() => undefined)
    await sleep(180)

    // Prefer direct goto when snapshot already bound a cross-path href (SPA cards).
    if (href !== '' && pathsDiffer(beforeUrl, href)) {
      await page.goto(href, { waitUntil: 'domcontentloaded' })
      await settlePage(page)
      this.clearRefs(page)
      const after = page.url()
      return {
        url: after,
        title: await page.title().catch(() => ''),
        changed: pathsDiffer(beforeUrl, after),
        href,
        tabId: this.tabIdFor(page),
        warning: "Opened this ref's href after snapshot bound a nearby document link.",
      }
    }

    const navWait = page.waitForURL(url => pathsDiffer(beforeUrl, url.toString()), { timeout: 5_000 }).catch(() => null)
    await locator.click({ timeout: 5_000 })
    await Promise.race([navWait, sleep(800)])

    const popup = await popupWait
    if (popup !== null && !popup.isClosed()) {
      const adopted = await adoptPopup(popup, beforeUrl)
      if (adopted) {
        this.page = popup
        this.clearRefs(page)
        await settlePage(popup)
        return {
          url: popup.url(),
          title: await popup.title().catch(() => ''),
          changed: true,
          ...(href !== '' ? { href } : {}),
          tabId: this.tabIdFor(popup),
          warning: 'Click opened a new tab; rebound the browser-agent session to it.',
        }
      }
    }

    await settlePage(page)
    let afterUrl = page.url()
    let changed = pathsDiffer(beforeUrl, afterUrl)

    // SPA pushState often lags the click — poll briefly (site-agnostic).
    if (!changed) {
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline && !changed) {
        await sleep(300)
        afterUrl = page.url()
        changed = pathsDiffer(beforeUrl, afterUrl)
      }
    }

    let followedHref = false
    if (!changed && href !== '' && pathsDiffer(beforeUrl, href)) {
      await page.goto(href, { waitUntil: 'domcontentloaded' })
      await settlePage(page)
      afterUrl = page.url()
      changed = pathsDiffer(beforeUrl, afterUrl)
      followedHref = changed
    }

    this.clearRefs(page)

    let pageLinks: Array<{ href: string; name: string }> = []
    if (!changed && href === '') {
      pageLinks = await listHttpAnchors(page)
    }

    return {
      url: afterUrl,
      title: await page.title().catch(() => ''),
      changed,
      tabId: this.tabIdFor(page),
      ...(href !== '' ? { href } : {}),
      ...(pageLinks.length > 0 ? { pageLinks: pageLinks.slice(0, 8) } : {}),
      ...(followedHref
        ? { warning: "Click missed; opened this ref's own href via navigation." }
        : (!changed
          ? {
            warning: href !== ''
              ? "Pathname unchanged; could not open this ref's href. browser_navigate to this ref's href or pick another ref with href=."
              : (pageLinks.length > 0
                ? 'Pathname unchanged and this ref has no href (common for SPA cards). Prefer a snapshot ref that lists href=, or browser_navigate once to a page_links URL below — do NOT re-click this ref.'
                : 'Pathname unchanged and this ref has no href. browser_snapshot again, pick a ref with href=, or browser_navigate to a known URL. Do NOT re-click this ref.'),
          }
          : {})),
    }
  }

  private async clickAtPoint(
    page: Page,
    beforeUrl: string,
    href: string,
    record: PlaywrightRefRecord,
  ): Promise<BrowserActResult> {
    if (href !== '' && pathsDiffer(beforeUrl, href)) {
      await page.goto(href, { waitUntil: 'domcontentloaded' })
      await settlePage(page)
      this.clearRefs(page)
      const after = page.url()
      return {
        url: after,
        title: await page.title().catch(() => ''),
        changed: pathsDiffer(beforeUrl, after),
        href,
        tabId: this.tabIdFor(page),
        warning: "Ref stamp missing; opened this ref's href directly.",
      }
    }
    await page.mouse.move(record.x, record.y)
    await sleep(120)
    await page.mouse.click(record.x, record.y)
    await settlePage(page)
    const afterUrl = page.url()
    const changed = pathsDiffer(beforeUrl, afterUrl)
    this.clearRefs(page)
    return {
      url: afterUrl,
      title: await page.title().catch(() => ''),
      changed,
      tabId: this.tabIdFor(page),
      ...(href !== '' ? { href } : {}),
      ...(!changed
        ? {
          warning: 'Pathname unchanged after coordinate click. browser_snapshot again or browser_navigate by href.',
        }
        : {}),
    }
  }

  async type(ref: number, text: string): Promise<BrowserActResult> {
    const page = await this.requirePage()
    const tabId = this.tabIdFor(page)
    if (this.tabs.ref(tabId, ref) === undefined) {
      throw new Error(this.tabs.unknownRefMessage(ref, tabId))
    }
    const locator = page.locator(`[${PLAYWRIGHT_REF_ATTR}="${ref}"]`).first()
    const count = await locator.count().catch(() => 0)
    if (count === 0) {
      throw new Error(`Ref ${ref} is not stamped in the DOM; call browser_snapshot again`)
    }
    await locator.click({ timeout: 3_000 }).catch(() => undefined)
    const tag = await locator.evaluate(el => el.tagName.toLowerCase()).catch(() => '')
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      await locator.fill(text, { timeout: 5_000 })
    } else {
      await locator.pressSequentially(text, { delay: 10 })
    }
    await settlePage(page)
    this.clearRefs(page)
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      changed: false,
      tabId: this.tabIdFor(page),
    }
  }

  async scroll(dy: number): Promise<BrowserActResult> {
    const page = await this.requirePage()
    await page.mouse.wheel(0, dy)
    await sleep(80)
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      changed: false,
      tabId: this.tabIdFor(page),
    }
  }

  async wait(input: { readonly timeoutMs?: number; readonly text?: string } = {}): Promise<{
    readonly url: string
    readonly title: string
    readonly matched: boolean
    readonly tabId?: number
  }> {
    const page = await this.requirePage()
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 8_000, 200), 60_000)
    let matched = true
    if (typeof input.text === 'string' && input.text.trim() !== '') {
      try {
        await page.getByText(input.text.trim()).first().waitFor({ timeout: timeoutMs })
        matched = true
      } catch {
        matched = false
      }
    } else {
      await settlePage(page, timeoutMs)
    }
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      matched,
      tabId: this.tabIdFor(page),
    }
  }

  async screenshot(): Promise<{ readonly mime: string; readonly base64: string; readonly tabId?: number }> {
    const page = await this.requirePage()
    const buf = await page.screenshot({ type: 'png', fullPage: false })
    return {
      mime: 'image/png',
      base64: buf.toString('base64'),
      tabId: this.tabIdFor(page),
    }
  }

  async listTabs(): Promise<TabListBody> {
    // Do not ensureReady here — sidebar polls listTabs and must not auto-launch.
    // Agent tool path calls ensureConnected / ensureReady before listTabs.
    const pages = this.context?.pages() ?? []
    if (pages.length === 0) {
      return { tabs: [], boundTabId: null }
    }
    return {
      tabs: await Promise.all(pages.map(async p => ({
        tabId: this.tabIdFor(p),
        title: await p.title().catch(() => ''),
        url: p.url(),
        active: p === this.page,
        // Session bind and read-only scope are layered in install.listTabs.
        bound: p === this.page,
        readOnly: false,
      }))),
      boundTabId: this.page === null ? null : this.tabIdFor(this.page),
    }
  }

  startCapture(): void {
    if (this.capture !== null) return
    const context = this.context
    if (context === null) return
    this.capture = new CaptureBuffer(300)
    for (const page of context.pages()) this.attachCapture(page)
    context.on('page', page => this.attachCapture(page))
  }

  /**
   * Stop recording and drop the buffer. Listeners stay attached (they close over
   * the old buffer), so each one checks that it is still the live buffer.
   */
  stopCapture(): void {
    this.capture = null
  }

  private attachCapture(page: Page): void {
    if (this.capture === null || this.captureStartedPages.has(page)) return
    this.captureStartedPages.add(page)
    const tabId = this.tabIdFor(page)
    const stamp = () => Date.now()
    // Listeners cannot be detached from a live page, so they always read the
    // current buffer: stopCapture() nulls it, and a later startCapture() picks the
    // same listeners back up without attaching duplicates.
    const record = (entry: CaptureEntry): void => {
      this.capture?.push(entry)
    }
    page.on('console', message => {
      if (this.capture === null) return
      try {
        record({
          kind: 'console',
          at: stamp(),
          tabId,
          level: message.type(),
          // Console text can embed a request URL, so it gets the same masking as
          // the network layer; otherwise a failed fetch leaks its query string.
          text: clipText(redactText(message.text()), 500),
          ...(message.location().url === ''
            ? {}
            : { location: redactText(`${message.location().url}:${message.location().lineNumber}`) }),
        })
      } catch {
        // Page went away mid-event; captured data is best-effort.
      }
    })
    page.on('pageerror', error => {
      if (this.capture === null) return
      record({
        kind: 'console',
        at: stamp(),
        tabId,
        level: 'pageerror',
        text: clipText(redactText(error instanceof Error ? error.message : String(error)), 500),
      })
    })
    page.on('request', request => {
      if (this.capture === null) return
      this.requestStart.set(request, performance.now())
    })
    page.on('response', response => {
      if (this.capture === null) return
      const request = response.request()
      const started = this.requestStart.get(request)
      record({
        kind: 'request',
        at: stamp(),
        tabId,
        method: request.method(),
        url: redactUrl(response.url()),
        resourceType: request.resourceType(),
        status: response.status(),
        ...(started === undefined ? {} : { durationMs: Math.round(performance.now() - started) }),
      })
    })
    page.on('requestfailed', request => {
      if (this.capture === null) return
      const started = this.requestStart.get(request)
      record({
        kind: 'request',
        at: stamp(),
        tabId,
        method: request.method(),
        url: redactUrl(request.url()),
        resourceType: request.resourceType(),
        ...(started === undefined ? {} : { durationMs: Math.round(performance.now() - started) }),
        failure: clipText(request.failure()?.errorText ?? 'request failed', 160),
      })
    })
  }

  readCapture(input: {
    readonly kind: CaptureKind
    readonly limit?: number
    readonly clear?: boolean
    readonly tabId?: number
  }): { readonly entries: readonly CaptureEntry[]; readonly dropped: number; readonly skipped: number } {
    if (this.capture === null) return { entries: [], dropped: 0, skipped: 0 }
    return this.capture.read(input.kind, {
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.clear === undefined ? {} : { clear: input.clear }),
      ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
    })
  }

  async emulate(input: {
    readonly colorScheme?: 'light' | 'dark' | 'no-preference' | 'reset'
    readonly reducedMotion?: 'reduce' | 'no-preference' | 'reset'
    readonly viewport?: { readonly width: number; readonly height: number }
  }): Promise<EmulateResult> {
    const page = await this.requirePage()
    const applied: string[] = []
    const media: {
      colorScheme?: 'light' | 'dark' | 'no-preference' | null
      reducedMotion?: 'reduce' | 'no-preference' | null
    } = {}
    if (input.colorScheme !== undefined) {
      media.colorScheme = input.colorScheme === 'reset' ? null : input.colorScheme
      applied.push(`colorScheme=${input.colorScheme}`)
    }
    if (input.reducedMotion !== undefined) {
      media.reducedMotion = input.reducedMotion === 'reset' ? null : input.reducedMotion
      applied.push(`reducedMotion=${input.reducedMotion}`)
    }
    if (Object.keys(media).length > 0) await page.emulateMedia(media)
    if (input.viewport !== undefined) {
      const width = Math.min(Math.max(Math.trunc(input.viewport.width), 320), 3840)
      const height = Math.min(Math.max(Math.trunc(input.viewport.height), 240), 2160)
      await page.setViewportSize({ width, height })
      applied.push(`viewport=${width}x${height}`)
    }
    const tabId = this.tabIdFor(page)
    this.rememberEmulation(tabId, input)
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      applied,
      tabId: this.tabIdFor(page),
    }
  }

  /** Record a user demonstration in the bound tab until stopDemonstration(). */
  async startDemonstration(): Promise<void> {
    const page = await this.requirePage()
    if (this.demoPage !== null) await this.stopDemonstration().catch(() => undefined)
    this.demoPage = page
    this.demoNavSteps = []
    this.demoPageSteps = []
    const context = page.context()
    if (!this.demoBindingReady) {
      // Steps cross into Node as they happen, so a navigation cannot lose them.
      try {
        await context.exposeBinding('__dshDemoPush', (_source, step: DemoStep) => {
          if (this.demoPage === null) return
          pushDemoStep(this.demoPageSteps, step)
        })
        this.demoBindingReady = true
      } catch {
        // Already exposed by an earlier demonstration; the recorder keeps sending.
        this.demoBindingReady = true
      }
    }
    this.watchDemoNavigation(page)
    await page.evaluate(`(() => { ${DEMO_RECORDER_SOURCE} })()`).catch(() => undefined)
    if (this.demoPageHandler === null) {
      this.demoPageHandler = (opened: Page) => {
        if (this.demoPage === null) return
        this.watchDemoNavigation(opened)
        void opened.evaluate(`(() => { ${DEMO_RECORDER_SOURCE} })()`).catch(() => undefined)
      }
      context.on('page', this.demoPageHandler)
    }
  }

  /**
   * Record top-level http(s) navigations of the pages the demo touches and
   * re-arm the recorder on the new document (the old one dies with the page).
   */
  private watchDemoNavigation(page: Page): void {
    if (this.demoTrackedPages.has(page)) return
    this.demoTrackedPages.add(page)
    page.on('framenavigated', frame => {
      if (this.demoPage === null || frame !== page.mainFrame()) return
      const url = frame.url()
      if (!/^https?:\/\//i.test(url)) return
      this.demoNavSteps.push({ kind: 'navigate', at: Date.now(), url: redactUrl(url) })
      void frame.page().evaluate(`(() => { ${DEMO_RECORDER_SOURCE} })()`).catch(() => undefined)
    })
  }

  /** Stop recording and return the flow, secrets masked, repeats dropped. */
  demonstrationActive(): boolean {
    return this.demoPage !== null
  }

  async stopDemonstration(): Promise<readonly DemoStep[]> {
    const page = this.demoPage
    this.demoPage = null
    if (this.demoPageHandler !== null) {
      this.context?.off('page', this.demoPageHandler)
      this.demoPageHandler = null
    }
    if (page !== null && !page.isClosed()) {
      await page.evaluate(DEMO_STOP_SOURCE).catch(() => undefined)
    }
    for (const other of this.context?.pages() ?? []) {
      if (other === page || other.isClosed()) continue
      await other.evaluate(DEMO_STOP_SOURCE).catch(() => undefined)
    }
    const steps = sanitizeDemoSteps(mergeDemoSteps(this.demoPageSteps, this.demoNavSteps))
    this.demoNavSteps = []
    this.demoPageSteps = []
    return steps
  }

  /** Record what is now emulated on this tab, so snapshot can echo it. */
  private rememberEmulation(
    tabId: number,
    input: {
      readonly colorScheme?: 'light' | 'dark' | 'no-preference' | 'reset'
      readonly reducedMotion?: 'reduce' | 'no-preference' | 'reset'
      readonly viewport?: { readonly width: number; readonly height: number }
    },
  ): void {
    const next = { ...(this.emulationByTab.get(tabId) ?? {}) }
    if (input.colorScheme !== undefined) {
      if (input.colorScheme === 'reset') delete next.colorScheme
      else next.colorScheme = input.colorScheme
    }
    if (input.reducedMotion !== undefined) {
      if (input.reducedMotion === 'reset') delete next.reducedMotion
      else next.reducedMotion = input.reducedMotion
    }
    if (input.viewport !== undefined) {
      next.viewport = {
        width: Math.min(Math.max(Math.trunc(input.viewport.width), 320), 3840),
        height: Math.min(Math.max(Math.trunc(input.viewport.height), 240), 2160),
      }
    }
    if (Object.keys(next).length === 0) this.emulationByTab.delete(tabId)
    else this.emulationByTab.set(tabId, next)
  }

  async followTab(tabId: number, _activate = false): Promise<{
    readonly tabId: number
    readonly url: string
    readonly title: string
  }> {
    await this.ensureReady()
    const candidate = this.tabs.page(tabId)
    if (!this.isLivePage(candidate)) {
      throw new Error(`No running browser tab for tabId ${tabId} (it may have been closed); call browser_list_tabs for current ids`)
    }
    // Refs are kept per tab, so switching back does not force a re-snapshot.
    this.page = candidate
    this.touch(candidate)
    return { tabId, url: candidate.url(), title: await candidate.title().catch(() => '') }
  }

  async bind(tabId: number, _sessionId?: string): Promise<{
    readonly tabId: number
    readonly url: string
    readonly title: string
  }> {
    return this.followTab(tabId, true)
  }

  async dispose(): Promise<void> {
    const ctx = this.context
    const profileDir = this.launchedProfileDir
    this.context = null
    this.page = null
    this.channel = null
    this.launchedProfileDir = null
    this.capture = null
    if (ctx !== null) {
      await ctx.close().catch(() => undefined)
    }
    if (profileDir !== null) {
      stopAgentBrowserProcesses(profileDir)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** domcontentloaded + short network quiet (capped) for SPA hydration. */
async function settlePage(page: Page, quietMs = 800): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => undefined)
  await Promise.race([
    page.waitForLoadState('networkidle').catch(() => undefined),
    sleep(Math.min(Math.max(quietMs, 100), 3_000)),
  ])
  await sleep(50)
}

async function adoptPopup(popup: Page, beforeUrl: string): Promise<boolean> {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    if (popup.isClosed()) return false
    const url = popup.url()
    if (/^https?:\/\//i.test(url) && pathsDiffer(beforeUrl, url)) return true
    await sleep(250)
  }
  const url = popup.isClosed() ? '' : popup.url()
  return /^https?:\/\//i.test(url) && pathsDiffer(beforeUrl, url)
}

async function listHttpAnchors(page: Page): Promise<Array<{ href: string; name: string }>> {
  // Keep the evaluate body free of TypeScript syntax (Playwright serializes it).
  return page.evaluate(`(() => {
    var out = [];
    var seen = {};
    var nodes = document.querySelectorAll("a[href], area[href]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var href = "";
      try {
        href = String(el.href || el.getAttribute("href") || "");
        if (href.indexOf("//") === 0) href = location.protocol + href;
        if (href.charAt(0) === "/") href = new URL(href, location.href).href;
      } catch (e) {
        continue;
      }
      if (!/^https?:\\/\\//i.test(href) || seen[href]) continue;
      seen[href] = true;
      var name = (el.getAttribute("aria-label") || el.innerText || "")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, 120);
      out.push({ href: href, name: name || href });
      if (out.length >= 24) break;
    }
    return out;
  })()`) as Promise<Array<{ href: string; name: string }>>
}

// Keep version export discoverable next to driver.
void PLAYWRIGHT_DRIVER_VERSION
