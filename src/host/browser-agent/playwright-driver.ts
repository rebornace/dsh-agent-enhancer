/**
 * Playwright-core driver for Desktop Browser Agent (sole shipping path).
 */

import { mkdirSync } from 'node:fs'
import type { BrowserContext, Page } from 'playwright-core'
import { chromium } from 'playwright-core'
import type {
  BrowserActResult,
  BrowserDriver,
  BrowserDriverStatus,
} from './driver.ts'
import {
  browserAgentProfileDirFor,
  playwrightChannelOrder,
  resolveBrowserExecutable,
  stopAgentBrowserProcesses,
  type BrowserPreference,
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
import { pathsDiffer } from './auto-nav.ts'

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
  private channel: 'msedge' | 'chrome' | null = null
  private launchedProfileDir: string | null = null
  private lastRefs = new Map<number, PlaywrightRefRecord>()

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

  /** Latest snapshot refs — used by the click/type path. */
  refOf(ref: number): PlaywrightRefRecord | undefined {
    return this.lastRefs.get(ref)
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
    const profileDir = this.currentProfileDir()
    const wantChannel = playwrightChannelOrder(preference, process.platform)[0]!
    const runningOk = this.context !== null
      && this.page !== null
      && !this.page.isClosed()
      && this.channel === wantChannel
      && this.launchedProfileDir === profileDir

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
    this.stopPreferenceProfiles(profileDir)

    mkdirSync(profileDir, { recursive: true })

    const order = [...playwrightChannelOrder(preference, process.platform)]
    let lastDetail = ''
    for (const channel of order) {
      const kind = channel === 'msedge' ? 'edge' : 'chrome'
      // Prefer explicit exe so channel name never silently picks the wrong browser.
      const resolved = resolveBrowserExecutable(kind)
      if (preference === 'chrome' || preference === 'edge') {
        if (resolved === null || resolved.kind !== preference) {
          lastDetail = `${preference} is not installed or not found on PATH`
          this.lastError = lastDetail
          continue
        }
      } else if (resolved === null) {
        lastDetail = `${kind} is not installed or not found on PATH`
        this.lastError = lastDetail
        continue
      }

      try {
        const context = await chromium.launchPersistentContext(profileDir, {
          executablePath: resolved!.executable,
          headless: this.headless,
          // Avoid Edge/Chrome infobar: "unsupported command-line flag: --no-sandbox".
          chromiumSandbox: true,
          ignoreDefaultArgs: ['--no-sandbox'],
          viewport: this.headless ? { width: 1280, height: 800 } : null,
          args: ['--no-first-run', '--no-default-browser-check', '--disable-default-apps'],
        })
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
          this.lastRefs.clear()
        })
        return
      } catch (error) {
        lastDetail = error instanceof Error ? error.message : String(error)
        this.lastError = lastDetail
      }
    }
    const hint = preference === 'chrome' || preference === 'edge'
      ? ` Preference is locked to ${preference} (no silent fallback).`
      : ''
    throw new Error(
      `Playwright could not launch a persistent browser (tried ${order.join(', ')}): ${lastDetail}.${hint}`,
    )
  }

  private stopPreferenceProfiles(activeProfileDir: string): void {
    stopAgentBrowserProcesses(activeProfileDir)
    if (this.launchedProfileDir !== null && this.launchedProfileDir !== activeProfileDir) {
      stopAgentBrowserProcesses(this.launchedProfileDir)
    }
    if (this.profileRoot !== undefined) {
      for (const slot of ['auto', 'chrome', 'edge'] as const) {
        const dir = browserAgentProfileDirFor(this.profileRoot, slot)
        if (dir !== activeProfileDir) stopAgentBrowserProcesses(dir)
      }
    }
  }

  private async requirePage(): Promise<Page> {
    await this.ensureReady()
    if (this.page === null || this.page.isClosed()) {
      throw new Error('Playwright page is not available')
    }
    return this.page
  }

  async pageStatus(): Promise<StatusBody> {
    const page = await this.requirePage()
    return {
      connected: true,
      url: page.url(),
      title: await page.title().catch(() => ''),
      tabId: 1,
      bound: true,
    }
  }

  async navigate(url: string): Promise<{ readonly url: string; readonly title: string; readonly tabId?: number }> {
    const page = await this.requirePage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await settlePage(page)
    this.lastRefs.clear()
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      tabId: 1,
    }
  }

  async snapshot(): Promise<SnapshotBody> {
    const page = await this.requirePage()
    const { body, refs } = await capturePlaywrightSnapshot(page)
    this.lastRefs = new Map(refs)
    return body
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
      tabId: 1,
    }
  }

  async click(ref: number): Promise<BrowserActResult> {
    const page = await this.requirePage()
    const record = this.lastRefs.get(ref)
    if (record === undefined) {
      throw new Error(`Unknown ref ${ref}; call browser_snapshot first`)
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
      this.lastRefs.clear()
      const after = page.url()
      return {
        url: after,
        title: await page.title().catch(() => ''),
        changed: pathsDiffer(beforeUrl, after),
        href,
        tabId: 1,
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
        this.lastRefs.clear()
        await settlePage(popup)
        return {
          url: popup.url(),
          title: await popup.title().catch(() => ''),
          changed: true,
          ...(href !== '' ? { href } : {}),
          tabId: tabIdOf(context, popup),
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

    this.lastRefs.clear()

    let pageLinks: Array<{ href: string; name: string }> = []
    if (!changed && href === '') {
      pageLinks = await listHttpAnchors(page)
    }

    return {
      url: afterUrl,
      title: await page.title().catch(() => ''),
      changed,
      tabId: 1,
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
      this.lastRefs.clear()
      const after = page.url()
      return {
        url: after,
        title: await page.title().catch(() => ''),
        changed: pathsDiffer(beforeUrl, after),
        href,
        tabId: 1,
        warning: "Ref stamp missing; opened this ref's href directly.",
      }
    }
    await page.mouse.move(record.x, record.y)
    await sleep(120)
    await page.mouse.click(record.x, record.y)
    await settlePage(page)
    const afterUrl = page.url()
    const changed = pathsDiffer(beforeUrl, afterUrl)
    this.lastRefs.clear()
    return {
      url: afterUrl,
      title: await page.title().catch(() => ''),
      changed,
      tabId: 1,
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
    if (this.lastRefs.get(ref) === undefined) {
      throw new Error(`Unknown ref ${ref}; call browser_snapshot first`)
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
    this.lastRefs.clear()
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      changed: false,
      tabId: 1,
    }
  }

  async scroll(dy: number): Promise<BrowserActResult> {
    const page = await this.requirePage()
    await page.mouse.wheel(0, dy)
    await sleep(80)
    return { url: page.url(), title: await page.title().catch(() => ''), changed: false, tabId: 1 }
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
      tabId: 1,
    }
  }

  async screenshot(): Promise<{ readonly mime: string; readonly base64: string; readonly tabId?: number }> {
    const page = await this.requirePage()
    const buf = await page.screenshot({ type: 'png', fullPage: false })
    return { mime: 'image/png', base64: buf.toString('base64'), tabId: 1 }
  }

  async listTabs(): Promise<TabListBody> {
    await this.ensureReady()
    const pages = this.context?.pages() ?? []
    return {
      tabs: await Promise.all(pages.map(async (p, index) => ({
        tabId: index + 1,
        title: await p.title().catch(() => ''),
        url: p.url(),
        active: p === this.page,
        bound: p === this.page,
      }))),
      boundTabId: this.page ? (pages.indexOf(this.page) + 1) : null,
    }
  }

  async followTab(tabId: number, _activate = false): Promise<{
    readonly tabId: number
    readonly url: string
    readonly title: string
  }> {
    await this.ensureReady()
    const pages = this.context?.pages() ?? []
    const page = pages[tabId - 1]
    if (page === undefined) throw new Error(`No Playwright page for tabId ${tabId}`)
    this.page = page
    this.lastRefs.clear()
    return { tabId, url: page.url(), title: await page.title().catch(() => '') }
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
    this.lastRefs.clear()
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

function tabIdOf(context: BrowserContext, page: Page): number {
  const pages = context.pages()
  const index = pages.indexOf(page)
  return index >= 0 ? index + 1 : 1
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
