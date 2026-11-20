import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const b = readFileSync('R:/deepseek-harness/resources/app.asar')
const headerLength = b.readUInt32LE(4)
const raw = b.subarray(16, 16 + headerLength).toString('utf8')
const header = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1))
const base = 16 + headerLength

function find(node, prefix, target) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = prefix === '' ? name : prefix + '/' + name
    if (full === target) return entry
    if (entry.files !== undefined) {
      const hit = find(entry, full, target)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

function list(node, prefix, match, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = prefix === '' ? name : prefix + '/' + name
    if (entry.files !== undefined) list(entry, full, match, out)
    else if (match.test(full)) out.push(full)
  }
  return out
}

const names = list(header, '', /permission-presets\/(lib|src)\//, [])
console.log(names.slice(0, 30).join('\n'))
console.log('total', names.length)

const wanted = [
  'dsh/node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js',
  'dsh/node_modules/@deepseek-ai/dsh-permission-presets/lib/index.d.ts',
  'dsh/node_modules/@deepseek-ai/dsh-permission-presets/README.zh.md',
]
for (const path of wanted) {
  const entry = find(header, '', path)
  if (entry === undefined) {
    console.log('miss', path)
    continue
  }
  const start = base + Number(entry.offset)
  const out = 'R:/Temp/dsh-pp/' + path.split('/').slice(-1)[0]
  mkdirSync('R:/Temp/dsh-pp', { recursive: true })
  writeFileSync(out, b.subarray(start, start + entry.size))
  console.log('extracted', out)
}
