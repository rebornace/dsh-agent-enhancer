/**
 * "Show me how" recording: the user demonstrates a flow in the dedicated
 * browser, we turn it into steps the agent can replay with browser_* tools.
 *
 * Privacy: a field whose type/name/autocomplete looks secret is recorded as
 * `***` on the page side, and the Node side masks again before formatting. Text
 * values are otherwise kept — the agent can already read the page.
 */

export type DemoStep =
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
  if (last !== undefined && step.at - last.at <= windowMs) {
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
    if (step.kind !== 'fill') return step
    if (step.masked || !isSensitiveFieldName(step.field, step.name, step.selector)) return step
    return { ...step, value: '***', masked: true }
  })
}

/** One line per step, capped, plus what a replay needs to know. */
export function summarizeDemoSteps(steps: readonly DemoStep[], max = 40): {
  readonly lines: readonly string[]
  readonly shown: number
  readonly masked: number
} {
  const shown = steps.slice(0, Math.max(1, max))
  const lines = shown.map((step, index) => {
    const n = index + 1
    switch (step.kind) {
      case 'navigate':
        return `${n}. navigate -> ${step.url}`
      case 'click':
        return `${n}. click ${step.role} ${JSON.stringify(step.name)}${step.href === undefined ? '' : ` (href ${step.href})`} [selector ${step.selector}]`
      case 'fill': {
        const value = step.masked ? '***' : JSON.stringify(step.value)
        const checked = step.checked === undefined ? '' : ` checked=${String(step.checked)}`
        return `${n}. fill ${step.role} ${JSON.stringify(step.name)} = ${value}${checked} [selector ${step.selector}]`
      }
      case 'press':
        return `${n}. press ${step.key} [selector ${step.selector}]`
      default: {
        const exhaustive: never = step
        return `${n}. ${JSON.stringify(exhaustive)}`
      }
    }
  })
  return {
    lines,
    shown: shown.length,
    masked: shown.filter(step => step.kind === 'fill' && step.masked).length,
  }
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
var recorder = {
  stop: function () {
    for (var i = 0; i < OFF.length; i++) { try { OFF[i](); } catch (e) { } }
    OFF.length = 0;
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
