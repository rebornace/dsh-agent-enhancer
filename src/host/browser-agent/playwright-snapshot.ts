/**
 * Page-side snapshot harvest for PlaywrightDriver.
 * Harvest runs as a string in the page (no TypeScript) so tsc cannot reject DOM APIs.
 */

import type { Page } from 'playwright-core'
import type { SnapshotBody, SnapshotNode } from './protocol.ts'
import { attachHrefByProximity, type ProximityAnchor, type ProximityNode } from './proximity.ts'

export const PLAYWRIGHT_DRIVER_VERSION = 'pw-0.1.0'
export const PLAYWRIGHT_REF_ATTR = 'data-dsh-ba-ref'
const MAX_NODES = 80

export interface PlaywrightRefRecord {
  readonly ref: number
  readonly role: string
  readonly name: string
  readonly href: string
  readonly x: number
  readonly y: number
  readonly tag: string
}

export interface PageHarvest {
  readonly interactive: ReadonlyArray<{
    readonly role: string
    readonly name: string
    readonly tag: string
    readonly href: string
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
    readonly sensitive: boolean
    readonly priority: number
  }>
  readonly anchors: ReadonlyArray<{
    readonly href: string
    readonly name: string
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }>
  readonly textPreview: string
}

/**
 * Serialized into the page via `new Function`. Keep free of TypeScript syntax.
 * Twin of the MV3 extension interactive+anchor harvest (universal; no site specials).
 */
export const HARVEST_PAGE_SNAPSHOT_SOURCE = `"use strict";
var REF = "data-dsh-ba-ref";
var SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=\\"hidden\\"])",
  "textarea",
  "select",
  "[role=\\"button\\"]",
  "[role=\\"link\\"]",
  "[role=\\"textbox\\"]",
  "[role=\\"checkbox\\"]",
  "[role=\\"radio\\"]",
  "[role=\\"menuitem\\"]",
  "[role=\\"tab\\"]",
  "[role=\\"option\\"]",
  "[role=\\"switch\\"]",
  "[contenteditable=\\"true\\"]"
].join(",");
var cleared = document.querySelectorAll("[" + REF + "]");
for (var ci = 0; ci < cleared.length; ci++) cleared[ci].removeAttribute(REF);
var interactive = [];
var seen = [];
function roleOf(el) {
  var explicit = el.getAttribute("role");
  if (explicit) return explicit;
  var tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    var type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button") return "button";
    return "textbox";
  }
  if (el.getAttribute("contenteditable") === "true") return "textbox";
  return tag;
}
function nameOf(el) {
  var labelled = el.getAttribute("aria-label");
  if (labelled && labelled.trim()) return labelled.trim().slice(0, 120);
  var labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    var ids = labelledBy.split(/\\s+/);
    var parts = [];
    for (var i = 0; i < ids.length; i++) {
      var node = document.getElementById(ids[i]);
      if (node === null) continue;
      var t = (node.innerText || node.textContent || "").trim();
      if (t) parts.push(t);
    }
    if (parts.length > 0) return parts.join(" ").slice(0, 120);
  }
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    var ph = el.getAttribute("placeholder");
    if (ph && ph.trim()) return ph.trim().slice(0, 120);
  }
  var text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
  if (text) return text.slice(0, 120);
  return el.tagName.toLowerCase();
}
function alreadySeen(el) {
  for (var i = 0; i < seen.length; i++) if (seen[i] === el) return true;
  return false;
}
function pushEl(el, forceHref) {
  if (!(el instanceof HTMLElement) || alreadySeen(el)) return;
  var style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return;
  var rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  seen.push(el);
  var type = (el.getAttribute("type") || "").toLowerCase();
  var sensitive = type === "password"
    || el.getAttribute("autocomplete") === "current-password"
    || el.getAttribute("autocomplete") === "new-password";
  var anchor = typeof el.closest === "function" ? el.closest("a[href]") : null;
  var hrefRaw = forceHref
    || (anchor && anchor.href ? String(anchor.href) : "")
    || (el.tagName === "A" && el.href ? String(el.href) : "")
    || "";
  var href = /^https?:\\/\\//i.test(hrefRaw) ? hrefRaw : "";
  interactive.push({
    role: roleOf(el),
    name: sensitive ? (nameOf(el) || "password") : nameOf(el),
    tag: el.tagName.toLowerCase(),
    href: href,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    w: rect.width,
    h: rect.height,
    sensitive: sensitive,
    priority: href ? 0 : 1
  });
}
var allAnchors = document.querySelectorAll("a[href]");
for (var ai = 0; ai < allAnchors.length; ai++) {
  var a = allAnchors[ai];
  if (!/^https?:\\/\\//i.test(a.href || "")) continue;
  pushEl(a, a.href || "");
}
var matched = document.querySelectorAll(SELECTOR);
for (var mi = 0; mi < matched.length; mi++) pushEl(matched[mi], "");
interactive.sort(function (a, b) { return a.priority - b.priority; });
var anchors = [];
var seenHref = {};
function pushAnchor(el, hrefOverride) {
  var href = hrefOverride || "";
  try {
    if (!href && el.href) href = String(el.href);
    if (!href) href = el.getAttribute("href") || "";
    if (href.indexOf("//") === 0) href = location.protocol + href;
    if (href.charAt(0) === "/") href = new URL(href, location.href).href;
  } catch (e) {
    return;
  }
  if (!/^https?:\\/\\//i.test(href)) return;
  var rect = el.getBoundingClientRect();
  var key = href + "@" + Math.round(rect.left) + "," + Math.round(rect.top);
  if (seenHref[key]) return;
  seenHref[key] = true;
  var name = (el.getAttribute("aria-label") || el.innerText || "")
    .replace(/\\s+/g, " ")
    .trim()
    .slice(0, 120);
  anchors.push({
    href: href,
    name: name || href,
    x: rect.left,
    y: rect.top,
    w: rect.width,
    h: rect.height
  });
}
var hrefEls = document.querySelectorAll("a[href], area[href]");
for (var hi = 0; hi < hrefEls.length; hi++) pushAnchor(hrefEls[hi], "");
var dataEls = document.querySelectorAll("[data-href],[data-url],[data-target-url],[data-link]");
var dataAttrs = ["data-href", "data-url", "data-target-url", "data-link"];
for (var di = 0; di < dataEls.length; di++) {
  for (var dai = 0; dai < dataAttrs.length; dai++) {
    var raw = dataEls[di].getAttribute(dataAttrs[dai]);
    if (raw) pushAnchor(dataEls[di], raw);
  }
}
var textPreview = "";
try {
  var root = document.querySelector("main, article, [role=\\"main\\"]") || document.body;
  textPreview = ((root && root.innerText) || "").replace(/\\s+/g, " ").trim().slice(0, 2000);
} catch (e) {
  textPreview = "";
}
return { interactive: interactive, anchors: anchors, textPreview: textPreview };
`

const STAMP_REFS_SOURCE = `"use strict";
var attr = __dsh.attr;
var records = __dsh.records;
var cleared = document.querySelectorAll("[" + attr + "]");
for (var i = 0; i < cleared.length; i++) cleared[i].removeAttribute(attr);
for (var ri = 0; ri < records.length; ri++) {
  var rec = records[ri];
  var hit = document.elementFromPoint(rec.x, rec.y);
  var target = hit;
  if (target && target.nodeType === 3) target = target.parentElement;
  if (!target) continue;
  var preferred = target.closest
    ? (target.closest("a[href], button, input, textarea, select, [role=\\"link\\"], [role=\\"button\\"], [contenteditable=\\"true\\"]") || target)
    : target;
  preferred.setAttribute(attr, String(rec.ref));
}
`

export async function capturePlaywrightSnapshot(page: Page): Promise<{
  readonly body: SnapshotBody
  readonly refs: ReadonlyMap<number, PlaywrightRefRecord>
}> {
  // String IIFE so Playwright treats it as an expression (not a TS-checked function).
  const harvest = await page.evaluate(`(() => { ${HARVEST_PAGE_SNAPSHOT_SOURCE} })()`) as PageHarvest
  const proximityNodes: ProximityNode[] = harvest.interactive.map(item => ({
    href: item.href,
    name: item.name,
    x: item.x,
    y: item.y,
    priority: item.priority,
  }))
  const proximityAnchors: ProximityAnchor[] = harvest.anchors.map(item => ({
    href: item.href,
    name: item.name,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
  }))
  const proximityHits = attachHrefByProximity(proximityNodes, proximityAnchors)

  type Row = {
    readonly name: string
    readonly role: string
    readonly tag: string
    readonly href: string
    readonly x: number
    readonly y: number
    readonly sensitive: boolean
    readonly priority: number
  }

  const rows: Row[] = proximityNodes.map((node, index) => {
    const item = harvest.interactive[index]
    const href = typeof node.href === 'string' && /^https?:\/\//i.test(node.href) ? node.href : ''
    return {
      name: node.name || item?.name || 'link',
      role: item?.role || 'link',
      tag: item?.tag || 'a',
      href,
      x: typeof node.x === 'number' ? node.x : 0,
      y: typeof node.y === 'number' ? node.y : 0,
      sensitive: item?.sensitive === true,
      priority: node.priority ?? (href ? 0 : 1),
    }
  })

  const knownHrefs = new Set(rows.map(r => r.href).filter(h => h !== ''))
  for (const anchor of proximityAnchors) {
    if (knownHrefs.has(anchor.href)) continue
    knownHrefs.add(anchor.href)
    rows.push({
      name: anchor.name || anchor.href,
      role: 'link',
      tag: 'a',
      href: anchor.href,
      x: anchor.x + anchor.w / 2,
      y: anchor.y + anchor.h / 2,
      sensitive: false,
      priority: 0,
    })
  }

  rows.sort((a, b) => a.priority - b.priority)
  const limited = rows.slice(0, MAX_NODES)

  const nodes: SnapshotNode[] = []
  const refs = new Map<number, PlaywrightRefRecord>()
  for (const row of limited) {
    const ref = nodes.length + 1
    nodes.push({
      ref,
      role: row.role,
      name: row.name,
      tag: row.tag,
      ...(row.href !== '' ? { href: row.href } : {}),
      ...(row.sensitive ? { sensitive: true } : {}),
    })
    refs.set(ref, {
      ref,
      role: row.role,
      name: row.name,
      href: row.href,
      x: row.x,
      y: row.y,
      tag: row.tag,
    })
  }

  await page.evaluate(
    ({ source, attr, records }) => {
      const run = new Function('__dsh', source) as (payload: {
        attr: string
        records: Array<{ ref: number; x: number; y: number }>
      }) => void
      run({ attr, records })
    },
    {
      source: STAMP_REFS_SOURCE,
      attr: PLAYWRIGHT_REF_ATTR,
      records: [...refs.values()].map(r => ({ ref: r.ref, x: r.x, y: r.y })),
    },
  )

  const withHref = nodes.filter(n => typeof n.href === 'string' && n.href !== '').length
  const body: SnapshotBody = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    nodes,
    textPreview: harvest.textPreview,
    tabId: 1,
    source: harvest.anchors.length > 0 || proximityHits > 0 ? 'playwright+anchors' : 'playwright',
    extensionVersion: PLAYWRIGHT_DRIVER_VERSION,
    anchorCount: harvest.anchors.length,
    ...(withHref === 0
      ? {
        note: `No http(s) href on interactive refs yet (anchors_in_dom=${harvest.anchors.length}). browser_wait then browser_snapshot again.`,
      }
      : (proximityHits > 0
        ? { note: `Bound ${proximityHits} ref(s) to nearby document hrefs (anchors_in_dom=${harvest.anchors.length}).` }
        : { note: `anchors_in_dom=${harvest.anchors.length}` })),
  }
  return { body, refs }
}
