/**
 * One-line detail for a tool call, so a run reads as stages instead of tool ids.
 *
 * The host does not localize: it reports the tool name plus a raw detail
 * (command, path, url, ref) and the client picks the verb from its own locale.
 */

const MAX_DETAIL = 80

const DETAIL_KEYS: readonly string[] = [
  'command',
  'path',
  'file_path',
  'filePath',
  'url',
  'message',
  'query',
  'pattern',
  'description',
  'name',
]

/** Collapse runs of whitespace and clip, keeping the head of the value. */
export function clipDetail(raw: string, max = MAX_DETAIL): string {
  const flat = raw.replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function readArg(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const value = (args as Record<string, unknown>)[key]
  if (typeof value === 'string' && value.trim() !== '') return value
  if (Array.isArray(value)) {
    const first = value.find(item => typeof item === 'string' && item.trim() !== '')
    if (typeof first === 'string') return first
  }
  return undefined
}

/**
 * Target of a tool call for the progress line. Shell keeps only the first line
 * (heredocs and `&&` chains would otherwise fill the row).
 */
export function stageDetail(tool: string, args: unknown): string | undefined {
  const command = readArg(args, 'command')
  if (command !== undefined && tool.toLowerCase().includes('shell')) {
    const firstLine = command.split(/\r?\n/u)[0] ?? ''
    return clipDetail(firstLine)
  }
  for (const key of DETAIL_KEYS) {
    const value = readArg(args, key)
    if (value === undefined) continue
    if (key === 'command') {
      const firstLine = value.split(/\r?\n/u)[0] ?? ''
      return clipDetail(firstLine)
    }
    return clipDetail(value)
  }
  // Last resort: the first short string anywhere in the args.
  if (args !== null && typeof args === 'object') {
    for (const value of Object.values(args as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim() !== '') return clipDetail(value)
    }
  }
  return undefined
}
