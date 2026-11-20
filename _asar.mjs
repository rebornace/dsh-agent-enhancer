import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const b = readFileSync('R:/deepseek-harness/resources/app.asar')
const headerLength = b.readUInt32LE(4)
const raw = b.subarray(16, 16 + headerLength).toString('utf8')
const header = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1))
const base = 16 + headerLength

const wanted = [
  'dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/src/index.ts',
  'dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/README.zh.md',
  'dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/package.json',
  'dsh/node_modules/@deepseek-ai/dsh/docs/upgrade-guide/v0.2.1-rc.2/auto-review-shutdown/guide.zh.md',
  'dsh/node_modules/@deepseek-ai/dsh/docs/upgrade-guide/v0.2.1-rc.2/auto-review-user-sources/guide.zh.md',
]

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

const outDir = 'R:/Temp/dsh-ar'
for (const path of wanted) {
  const entry = find(header, '', path)
  if (entry === undefined || entry.unpacked === true) {
    console.log('miss', path)
    continue
  }
  const start = base + Number(entry.offset)
  const data = b.subarray(start, start + entry.size)
  const out = outDir + '/' + path.split('/').slice(-1)[0]
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, data)
  console.log('extracted', out, entry.size)
}
