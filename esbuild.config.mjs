import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { cssModulesPlugin } from './scripts/css-modules-plugin.mjs'

function relativizeSourceMap(raw) {
  const map = JSON.parse(raw)
  map.sources = map.sources.map(source => {
    let path = source
    if (path.startsWith('file:')) path = fileURLToPath(path)
    if (isAbsolute(path)) path = relative(process.cwd(), path)
    return path.replaceAll('\\', '/')
  })
  return `${JSON.stringify(map)}\n`
}

const execFileAsync = promisify(execFile)
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const external = ['@deepseek-ai/*', 'react', 'react/*', 'react-dom', 'react-dom/*']

function assertExternalRuntime(result, target) {
  const bundled = Object.keys(result.metafile.inputs).filter(path =>
    /(?:^|\/)(?:react|react-dom)(?:\/|$)|@deepseek-ai\//.test(path))
  if (bundled.length > 0) {
    throw new Error(`${target} build bundled external runtime: ${bundled.join(', ')}`)
  }
}

await rm('lib', { recursive: true, force: true })
await mkdir('lib', { recursive: true })

const host = await build({
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  metafile: true,
  external: [...external, 'zod', 'zod/*'],
})
assertExternalRuntime(host, 'Host')

const client = await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: 'external',
  metafile: true,
  external: [...external, 'zod', 'zod/*'],
  plugins: [
    {
      name: 'dsh-client-module-ids',
      setup(builder) {
        builder.onResolve({ filter: /^@deepseek-ai\/.*\/client$/ }, args => ({
          path: args.path.replace(/\/client$/, ''),
          external: true,
        }))
      },
    },
    cssModulesPlugin(),
  ],
})
assertExternalRuntime(client, 'Client')

const javascript = client.outputFiles.find(file => file.path.endsWith('.js'))
const sourcemap = client.outputFiles.find(file => file.path.endsWith('.js.map'))
if (javascript === undefined) throw new Error('Client build emitted no JavaScript')
if (sourcemap === undefined) throw new Error('Client build emitted no sourcemap')
await writeFile(
  'lib/client.js',
  `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{\n` +
    `var module={exports:{}};var exports=module.exports;\n${javascript.text}\nreturn module.exports;\n}});\n`,
)
await writeFile('lib/client.js.map', relativizeSourceMap(sourcemap.text))

const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'))
await execFileAsync(process.execPath, [tsc, '-p', 'tsconfig.build.json'])
