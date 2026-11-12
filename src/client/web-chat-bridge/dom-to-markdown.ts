/**
 * Lightweight HTML → Markdown for DeepSeek web-chat DOM capture.
 * Prefer history_messages / share APIs when available; this is the rendered fallback
 * so imported turns keep code fences, lists, and emphasis instead of one flattened line.
 */

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'SVG', 'BUTTON', 'NOSCRIPT', 'TEMPLATE',
])

function collapseInline(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ')
}

function trimBlankLines(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function fenceLanguage(el: Element): string {
  const className = el.getAttribute('class') ?? ''
  const match = className.match(/(?:language|lang)-([A-Za-z0-9_+-]+)/i)
  return match?.[1] ?? ''
}

function isBlock(tag: string): boolean {
  return tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE'
    || tag === 'LI' || tag === 'BLOCKQUOTE' || tag === 'PRE' || tag === 'TABLE'
    || tag === 'TR' || tag === 'H1' || tag === 'H2' || tag === 'H3'
    || tag === 'H4' || tag === 'H5' || tag === 'H6' || tag === 'UL'
    || tag === 'OL' || tag === 'HR'
}

function walk(node: Node, listDepth: number): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return collapseInline(node.textContent ?? '')
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as Element
  const tag = el.tagName.toUpperCase()
  if (SKIP_TAGS.has(tag)) return ''

  if (tag === 'BR') return '\n'

  if (tag === 'HR') return '\n\n---\n\n'

  if (/^H[1-6]$/.test(tag)) {
    const level = Number(tag[1])
    const body = trimBlankLines(childrenMarkdown(el, listDepth))
    if (body === '') return ''
    return `\n\n${'#'.repeat(level)} ${body}\n\n`
  }

  if (tag === 'PRE') {
    const code = el.querySelector('code') ?? el
    const lang = fenceLanguage(code)
    const body = (code.textContent ?? '').replace(/\n$/, '')
    return `\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`
  }

  if (tag === 'CODE' && el.parentElement?.tagName.toUpperCase() !== 'PRE') {
    const body = (el.textContent ?? '').replace(/`/g, '\\`')
    return `\`${body}\``
  }

  if (tag === 'STRONG' || tag === 'B') {
    const body = childrenMarkdown(el, listDepth).trim()
    return body === '' ? '' : `**${body}**`
  }

  if (tag === 'EM' || tag === 'I') {
    const body = childrenMarkdown(el, listDepth).trim()
    return body === '' ? '' : `*${body}*`
  }

  if (tag === 'A') {
    const href = el.getAttribute('href')?.trim() ?? ''
    const body = childrenMarkdown(el, listDepth).trim() || href
    if (body === '') return ''
    if (href === '' || href.startsWith('javascript:')) return body
    return `[${body}](${href})`
  }

  if (tag === 'BLOCKQUOTE') {
    const body = trimBlankLines(childrenMarkdown(el, listDepth))
    if (body === '') return ''
    const quoted = body.split('\n').map(line => `> ${line}`).join('\n')
    return `\n\n${quoted}\n\n`
  }

  if (tag === 'UL' || tag === 'OL') {
    const items = Array.from(el.children).filter(child => child.tagName.toUpperCase() === 'LI')
    const lines: string[] = []
    items.forEach((item, index) => {
      const marker = tag === 'OL' ? `${index + 1}.` : '-'
      const indent = '  '.repeat(listDepth)
      const body = trimBlankLines(childrenMarkdown(item, listDepth + 1))
      const [first, ...rest] = body.split('\n')
      lines.push(`${indent}${marker} ${first ?? ''}`.trimEnd())
      for (const line of rest) {
        lines.push(`${indent}  ${line}`.trimEnd())
      }
    })
    return lines.length === 0 ? '' : `\n\n${lines.join('\n')}\n\n`
  }

  if (tag === 'LI') {
    return childrenMarkdown(el, listDepth)
  }

  if (tag === 'TABLE') {
    return tableMarkdown(el)
  }

  const inner = childrenMarkdown(el, listDepth)
  if (isBlock(tag)) {
    const body = trimBlankLines(inner)
    return body === '' ? '' : `\n\n${body}\n\n`
  }
  return inner
}

function childrenMarkdown(el: Element, listDepth: number): string {
  let out = ''
  for (const child of Array.from(el.childNodes)) {
    out += walk(child, listDepth)
  }
  return out
}

function tableMarkdown(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr'))
  if (rows.length === 0) return ''
  const matrix = rows.map(row => Array.from(row.querySelectorAll('th,td')).map(cell =>
    trimBlankLines(childrenMarkdown(cell, 0)).replace(/\|/g, '\\|').replace(/\n+/g, ' ')))
  const width = Math.max(1, ...matrix.map(row => row.length))
  const normalized = matrix.map(row => {
    const next = [...row]
    while (next.length < width) next.push('')
    return next
  })
  const header = normalized[0]!
  const sep = Array.from({ length: width }, () => '---')
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...normalized.slice(1).map(row => `| ${row.join(' | ')} |`),
  ]
  return `\n\n${lines.join('\n')}\n\n`
}

/** Convert a rendered message DOM subtree into Markdown-ish text. */
export function domToMarkdown(root: Element): string {
  return trimBlankLines(walk(root, 0))
}

/**
 * Preserve newlines from plain innerText without collapsing the whole message
 * into a single line (legacy capture bug).
 */
export function preserveVisibleText(raw: string): string {
  return trimBlankLines(
    raw
      .replace(/\u00a0/g, ' ')
      .replace(/\t/g, ' ')
      .replace(/ +\n/g, '\n')
      .replace(/\n +/g, '\n')
      .replace(/ {2,}/g, ' '),
  )
}
