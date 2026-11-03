import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const pnpmCli = process.env.npm_execpath
if (pnpmCli === undefined) throw new Error('verify-package must be run by pnpm')
const manifest = JSON.parse(await readFile('package.json', 'utf8'))

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })
let tarball
try {
  const { stdout: packOutput } = await execFileAsync(process.execPath, [
    pnpmCli,
    'pack',
    '--pack-destination',
    'dist',
    '--json',
  ])
  const packed = JSON.parse(packOutput)
  tarball = relative(process.cwd(), resolve(packed.filename))
} catch {
  const { stdout: packOutput } = await execFileAsync(process.execPath, [
    pnpmCli,
    'pack',
    '--pack-destination',
    'dist',
  ])
  const line = packOutput.trim().split(/\r?\n/).find(entry => entry.endsWith('.tgz'))
  if (line === undefined) throw new Error(`pnpm pack did not print tarball path: ${packOutput}`)
  tarball = relative(process.cwd(), resolve(line.trim()))
}
const { stdout: fileOutput } = await execFileAsync('tar', ['-tf', tarball])
const files = fileOutput.trim().split(/\r?\n/).filter(Boolean)

const required = [
  'package/package.json',
  'package/cordis.patch.yml',
  'package/lib/index.js',
  'package/lib/index.js.map',
  'package/lib/host/index.d.ts',
  'package/lib/host/index.d.ts.map',
  'package/lib/client.js',
  'package/lib/client.js.map',
  'package/lib/client/index.d.ts',
  'package/lib/client/index.d.ts.map',
]
const missing = required.filter(path => !files.includes(path))
if (missing.length > 0) throw new Error(`Package is missing: ${missing.join(', ')}`)

const forbidden = files.filter(path =>
  /^package\/(?:src|tests|research|docs|\.research-rc3)(?:\/|$)/.test(path))
if (forbidden.length > 0) throw new Error(`Package contains source material: ${forbidden.join(', ')}`)

async function readEntry(path) {
  const { stdout } = await execFileAsync('tar', ['-xOf', tarball, path], {
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}

const packedManifest = JSON.parse(await readEntry('package/package.json'))
if (packedManifest.name !== manifest.name || packedManifest.version !== manifest.version) {
  throw new Error('Packed manifest identity does not match package.json')
}
if (packedManifest.dsh?.bundle?.patch !== './cordis.patch.yml' ||
    packedManifest.dsh?.client?.platform !== 'web') {
  throw new Error('Packed manifest has invalid DSH metadata')
}
if (packedManifest.engines?.dsh !== '>=0.2.1-rc.5 <0.3.0-0') {
  throw new Error('Packed manifest has an invalid DSH compatibility range')
}

const absolutePath = /(?:file:\/\/\/|(?:^|[^a-zA-Z])[A-Z]:[\\/]|\/Users\/|\/home\/)/
for (const path of files.filter(path => path !== 'package/package.json' && /\.(?:js|map|ts|json|yml)$/.test(path))) {
  const contents = await readEntry(path)
  if (path.endsWith('.map')) {
    const map = JSON.parse(contents)
    const sources = Array.isArray(map.sources) ? map.sources : []
    if (sources.some(source => typeof source === 'string' && absolutePath.test(source))) {
      throw new Error(`Package contains an absolute source path: ${path}`)
    }
    continue
  }
  if (absolutePath.test(contents)) {
    throw new Error(`Package contains an absolute source path: ${path}`)
  }
}

const client = await readEntry('package/lib/client.js')
const bundledRuntime = /(?:node_modules\/|\/\/ )(?:react|react-dom|@deepseek-ai)\//.test(client)
if (bundledRuntime) throw new Error('Client contains bundled React or DSH shared runtime')
const clientMap = JSON.parse(await readEntry('package/lib/client.js.map'))
const runtimeSources = clientMap.sources.filter(path =>
  /(?:^|\/)(?:react|react-dom)(?:\/|$)|@deepseek-ai\//.test(path))
if (runtimeSources.length > 0) {
  throw new Error(`Client source map contains shared runtime: ${runtimeSources.join(', ')}`)
}

console.log(`Verified ${basename(tarball)} (${files.length} files)`)
