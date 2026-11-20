/**
 * "Show me how" recording: the user demonstrates a flow in the dedicated
 * browser, we turn it into steps the agent can replay with browser_* tools.
 *
 * Privacy: a field whose type/name/autocomplete looks secret is recorded as
 * `***` on the page side, and the Node side masks again before formatting. Text
 * values are otherwise kept — the agent can already read the page.
 */

import { redactUrl } from './capture.ts'

/** Where a step happened. Filled in on the Node side; the page cannot know the tab id. */
export interface DemoStepSite {
  /** Registry tab id (stable while the dedicated browser runs). */
  readonly tabId?: number
  /** Redacted page URL at the moment of the step. */
  readonly tabUrl?: string
}

type DemoStepPayload =
  | { readonly kind: 'navigate'; readonly at: number; readonly url: string }
  | {
    readonly kind: 'click'
    readonly at: number
    readonly role: string
    readonly name: string
    readonly selector: string
    readonly href?: string
  }
  | {
    readonly kind: 'fill'
    readonly at: number
    readonly role: string
    readonly name: string
    readonly selector: string
    readonly field: string
    readonly value: string
    readonly masked: boolean
    readonly checked?: boolean
  }
  | { readonly kind: 'press'; readonly at: number; readonly key: string; readonly selector: string }

export type DemoStep = DemoStepSite & DemoStepPayload

/** Tag a page-side step with the tab the user did it in. */
export function attachDemoTab(step: DemoStep, site: DemoStepSite): DemoStep {
  if (site.tabId === undefined) return step
  return {
    ...step,
    tabId: site.tabId,
    ...(site.tabUrl === undefined ? {} : { tabUrl: site.tabUrl }),
  }
}

const SECRET_FIELD = /pass(word)?|\bpw\b|\bpwd\b|otp|one[-_]?time|code|pin|cvv|cvc|secret|token|card[-_]?number|iban/i

/** Field identity that must never be recorded verbatim. */
export function isSensitiveFieldName(...parts: readonly (string | undefined | null)[]): boolean {
  return parts.some(part => typeof part === 'string' && SECRET_FIELD.test(part))
}

/**
 * Append a step, coalescing typing: several `input` events for the same field
 * (one per keystroke) collapse into the final value.
 */
export function pushDemoStep(steps: DemoStep[], step: DemoStep, windowMs = 1_500): void {
  const last = steps[steps.length - 1]
  // Fold only within one tab: the same selector in two tabs is two steps.
  if (last !== undefined && last.tabId === step.tabId && step.at - last.at <= windowMs) {
    // Typing the same field: keep only the final value.
    if (last.kind === 'fill' && step.kind === 'fill' && last.selector === step.selector) {
      steps[steps.length - 1] = step
      return
    }
    // Clicking into a field to type is not a step of its own.
    if (last.kind === 'click' && step.kind === 'fill' && last.selector === step.selector) {
      steps[steps.length - 1] = step
      return
    }
  }
  if (steps.length >= 200) return
  steps.push(step)
}

/** Merge page-side and driver-side steps in time order, dropping repeats. */
export function mergeDemoSteps(
  pageSteps: readonly DemoStep[],
  navSteps: readonly DemoStep[],
): DemoStep[] {
  const all = [...pageSteps, ...navSteps].sort((a, b) => a.at - b.at)
  const out: DemoStep[] = []
  for (const step of all) {
    const prev = out[out.length - 1]
    if (prev !== undefined && sameStep(prev, step)) continue
    out.push(step)
  }
  return out
}

function sameStep(a: DemoStep, b: DemoStep): boolean {
  if (a.tabId !== b.tabId) return false
  if (a.kind !== b.kind) return false
  if (a.kind === 'navigate' && b.kind === 'navigate') return a.url === b.url
  if (a.kind === 'click' && b.kind === 'click') return a.selector === b.selector
  if (a.kind === 'fill' && b.kind === 'fill') return a.selector === b.selector && a.value === b.value
  if (a.kind === 'press' && b.kind === 'press') return a.selector === b.selector && a.key === b.key
  return false
}

/** Belt-and-braces masking for steps that reached us with a raw value. */
export function sanitizeDemoSteps(steps: readonly DemoStep[]): DemoStep[] {
  return steps.map(step => {
    if (step.kind === 'navigate') {
      const url = redactUrl(step.url)
      return url === step.url ? step : { ...step, url }
    }
    if (step.kind !== 'fill') return step
    if (step.masked || !isSensitiveFieldName(step.field, step.name, step.selector)) return step
    return { ...step, value: '***', masked: true }
  })
}

/**
 * The same step in the user's words, for the sidebar. Variables show their
 * label, not the `${v1}` token, and selectors never appear.
 */
export function describeDemoStepHuman(
  step: DemoStep,
  variables: readonly { readonly name: string; readonly label: string }[] = [],
): string {
  const withLabels = (text: string): string => text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu,
    (match, name: string) => {
      const variable = variables.find(item => item.name === name)
      return variable === undefined ? match : `「${variable.label}」`
    },
  )
  const short = (text: string): string => (text.length > 60 ? `${text.slice(0, 60)}…` : text)
  switch (step.kind) {
    case 'navigate':
      return `打开 ${short(step.url)}`
    case 'click':
      return `点击「${step.name}」`
    case 'fill':
      if (step.masked) return `在「${step.name}」填密码（每次问你）`
      return `在「${step.name}」填 ${short(withLabels(step.value))}`
    case 'press':
      return `按 ${step.key}`
    default: {
      const exhaustive: never = step
      return JSON.stringify(exhaustive)
    }
  }
}

/** Action text for one step, without numbering (shared by summary and replay). */
export function describeDemoStep(step: DemoStep): string {  switch (step.kind) {
    case 'navigate':
      return `navigate -> ${step.url}`
    case 'click':
      return `click ${step.role} ${JSON.stringify(step.name)}${step.href === undefined ? '' : ` (href ${step.href})`} [selector ${step.selector}]`
    case 'fill': {
      const value = step.masked ? '***' : JSON.stringify(step.value)
      const checked = step.checked === undefined ? '' : ` checked=${String(step.checked)}`
      return `fill ${step.role} ${JSON.stringify(step.name)} = ${value}${checked} [selector ${step.selector}]`
    }
    case 'press':
      return `press ${step.key} [selector ${step.selector}]`
    default: {
      const exhaustive: never = step
      return JSON.stringify(exhaustive)
    }
  }
}

/** One tab the flow touched, in first-seen order. */
export interface DemoTabRef {
  readonly tabId: number
  readonly url?: string
}

export interface DemoStepSummary {
  readonly lines: readonly string[]
  readonly shown: number
  readonly masked: number
  /** Tabs the shown steps happened in. */
  readonly tabs: readonly DemoTabRef[]
  /** True when the flow crossed tabs, so every line is tagged. */
  readonly multiTab: boolean
}

/** One line per step, capped, plus what a replay needs to know. */
export function summarizeDemoSteps(steps: readonly DemoStep[], max = 40): DemoStepSummary {
  const shown = steps.slice(0, Math.max(1, max))
  const tabs = collectTabs(shown)
  const multiTab = tabs.length > 1
  const lines = shown.map((step, index) => {
    const n = index + 1
    const tag = multiTab && step.tabId !== undefined ? `[tab ${step.tabId}] ` : ''
    return `${n}. ${tag}${describeDemoStep(step)}`
  })
  return {
    lines,
    shown: shown.length,
    masked: shown.filter(step => step.kind === 'fill' && step.masked).length,
    tabs,
    multiTab,
  }
}

function collectTabs(steps: readonly DemoStep[]): DemoTabRef[] {
  const seen = new Map<number, DemoTabRef>()
  for (const step of steps) {
    if (step.tabId === undefined || seen.has(step.tabId)) continue
    seen.set(step.tabId, { tabId: step.tabId, ...(step.tabUrl === undefined ? {} : { url: step.tabUrl }) })
  }
  return [...seen.values()]
}

/**
 * Legend that makes `[tab N]` tags readable on their own. Empty for a
 * single-tab flow, where the tags are not printed either.
 */
export function demoTabLegend(summary: DemoStepSummary): readonly string[] {
  if (!summary.multiTab) return []
  return [
    `tabs: ${summary.tabs.length} (each step is tagged with the tab it happened in)`,
    ...summary.tabs.map(tab => `tab ${tab.tabId}: ${tab.url ?? '(url unknown)'}`),
  ]
}

const DEMO_SYMBOL = "Symbol.for('dsh-demo')"

/**
 * Page-side recorder. Runs as one evaluate() expression, then keeps listening
 * until stopped. State hides behind a symbol so `Object.keys(window)` stays clean.
 */
export const DEMO_RECORDER_SOURCE = `"use strict";
var KEY = ${DEMO_SYMBOL};
var existing = window[KEY];
if (existing) { try { existing.stop(); } catch (e) { } }
var SECRET = /pass(word)?|\\bpw\\b|\\bpwd\\b|otp|one[-_]?time|code|pin|cvv|cvc|secret|token|card[-_]?number|iban/i;
var steps = [];
var OFF = [];
function textOf(el, max) {
  var raw = el.getAttribute("aria-label") || el.getAttribute("title") || (el.innerText || el.textContent || "");
  return String(raw || "").replace(/\\s+/g, " ").trim().slice(0, max || 60);
}
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
  return tag;
}
function selectorOf(el) {
  try {
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id);
  } catch (e) { }
  var testid = el.getAttribute("data-testid") || el.getAttribute("data-test-id");
  if (testid) return '[data-testid="' + testid + '"]';
  var name = el.getAttribute("name");
  if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
  var parts = [];
  var node = el;
  while (node && node.nodeType === 1 && parts.length < 6) {
    var tag = node.tagName.toLowerCase();
    if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
    var parent = node.parentElement;
    var same = parent ? Array.prototype.filter.call(parent.children, function (child) { return child.tagName === node.tagName; }) : [];
    parts.unshift(same.length > 1 ? tag + ":nth-of-type(" + (same.indexOf(node) + 1) + ")" : tag);
    node = parent;
  }
  return parts.join(" > ");
}
function push(step) {
  step.at = Date.now();
  try { if (typeof window.__dshDemoPush === "function") window.__dshDemoPush(step); } catch (e) { }
}
function isSecret(el) {
  var type = (el.getAttribute("type") || "").toLowerCase();
  if (type === "password") return true;
  return SECRET.test(el.getAttribute("name") || "") || SECRET.test(el.id || "")
    || SECRET.test(el.getAttribute("autocomplete") || "") || SECRET.test(el.getAttribute("placeholder") || "");
}
function on(target, type, handler, capture) {
  target.addEventListener(type, handler, capture === true);
  OFF.push(function () { target.removeEventListener(type, handler, capture === true); });
}
// Single-page apps change the URL without loading a document, so the driver's
// framenavigated never fires. Patch the history API and listen for the events
// the browser dispatches for back/forward and hash routes.
var lastUrl = String(location.href || "");
function routeStep() {
  var url = String(location.href || "");
  if (url === lastUrl) return;
  lastUrl = url;
  if (!/^https?:\\/\\//i.test(url)) return;
  push({ kind: "navigate", url: url });
}
function wrapHistory(name) {
  var original = history[name];
  if (typeof original !== "function") return;
  try {
    history[name] = function () {
      var result = original.apply(this, arguments);
      try { setTimeout(routeStep, 0); } catch (e) { }
      return result;
    };
    OFF.push(function () { try { history[name] = original; } catch (e) { } });
  } catch (e) { }
}
wrapHistory("pushState");
wrapHistory("replaceState");
on(window, "popstate", routeStep);
on(window, "hashchange", routeStep);
on(document, "click", function (event) {
  var el = event.target && event.target.closest ? event.target.closest("a,button,input,select,textarea,[role],[contenteditable='true']") : null;
  if (!el) return;
  var href = el.tagName === "A" && el.href ? String(el.href) : "";
  push({ kind: "click", role: roleOf(el), name: textOf(el), selector: selectorOf(el), href: /^https?:\\/\\//i.test(href) ? href : "" });
}, true);
function fieldStep(el) {
  var tag = el.tagName.toLowerCase();
  var type = (el.getAttribute("type") || "").toLowerCase();
  if (tag === "select") {
    push({ kind: "fill", role: "combobox", name: textOf(el), selector: selectorOf(el), field: el.name || el.id || "select", value: String(el.value || ""), masked: false });
    return;
  }
  if (type === "checkbox" || type === "radio") {
    push({ kind: "fill", role: type, name: textOf(el), selector: selectorOf(el), field: el.name || el.id || type, value: el.checked ? "on" : "off", masked: false, checked: el.checked });
    return;
  }
  if (tag !== "input" && tag !== "textarea") return;
  var secret = isSecret(el);
  push({
    kind: "fill",
    role: roleOf(el),
    name: textOf(el) || el.getAttribute("placeholder") || "",
    selector: selectorOf(el),
    field: el.name || el.id || type || "field",
    value: secret ? "***" : String(el.value || ""),
    masked: secret,
  });
}
// "input" catches typing as it happens; "change" catches selects, checkboxes and blur.
on(document, "input", function (event) {
  var el = event.target;
  if (!el || !el.tagName) return;
  fieldStep(el);
}, true);
on(document, "change", function (event) {
  var el = event.target;
  if (!el || !el.tagName) return;
  var tag = el.tagName.toLowerCase();
  var type = (el.getAttribute("type") || "").toLowerCase();
  if (tag === "select" || type === "checkbox" || type === "radio") fieldStep(el);
}, true);
on(document, "keydown", function (event) {
  if (event.key !== "Enter") return;
  var el = event.target;
  if (!el || !el.tagName) return;
  push({ kind: "press", key: "Enter", selector: selectorOf(el) });
}, true);
// Visible "recording" marker. Styles are set through CSSOM (not a <style> tag)
// so a strict style-src CSP cannot hide it; the host is pointer-events:none and
// aria-hidden, so it can never eat a click or show up in a snapshot.
function mountBadge() {
  try {
    var stale = document.querySelector("[data-dsh-demo-badge]");
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    var host = document.createElement("div");
    host.setAttribute("data-dsh-demo-badge", "");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;pointer-events:none;";
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var zh = /^zh/i.test(navigator.language || "");
    var bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:12px;"
      + "background:rgba(17,24,39,.92);color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.28);"
      + "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";
    var dot = document.createElement("span");
    dot.style.cssText = "width:9px;height:9px;border-radius:50%;background:#ef4444;flex:0 0 auto;"
      + "box-shadow:0 0 0 3px rgba(239,68,68,.22);";
    var text = document.createElement("span");
    text.style.cssText = "display:flex;flex-direction:column;gap:1px;font-size:12px;line-height:1.35;";
    var title = document.createElement("span");
    title.textContent = zh ? "演示录制中" : "Recording";
    var hint = document.createElement("span");
    hint.textContent = zh ? "完成后回到 Desktop 结束录制" : "Return to Desktop to stop";
    hint.style.cssText = "font-size:11px;opacity:.72;";
    text.appendChild(title);
    text.appendChild(hint);
    bar.appendChild(dot);
    bar.appendChild(text);
    root.appendChild(bar);
    (document.body || document.documentElement).appendChild(host);
    return host;
  } catch (e) {
    return null;
  }
}
var badge = mountBadge();
var recorder = {
  stop: function () {
    for (var i = 0; i < OFF.length; i++) { try { OFF[i](); } catch (e) { } }
    OFF.length = 0;
    try { if (badge && badge.parentNode) badge.parentNode.removeChild(badge); } catch (e) { }
    badge = null;
    delete window[KEY];
  },
};
window[KEY] = recorder;
return true;
`

/** Detach listeners and drop the handle. */
export const DEMO_STOP_SOURCE = `(() => {
  const r = window[${DEMO_SYMBOL}];
  if (r) { try { r.stop(); } catch (e) { } }
  return true;
})()`
