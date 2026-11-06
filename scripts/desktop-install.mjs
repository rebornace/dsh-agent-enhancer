/**
 * Switch the Desktop profile between local pack install and npm.
 * Does NOT touch this repo's package.json — only ~/.dsh/profiles/desktop.
 *
 * Local mode packs, extracts into profile/.dsh-enhancer-pack/pkg (lib + patch
 * only, no node_modules), then depends on that directory. Plain link:/file: to
 * this repo becomes a Junction that exposes repo node_modules; Desktop then
 * loads duplicate @deepseek-ai/* instances and the component stays 「已关闭」.
 *
 *   node scripts/desktop-install.mjs link   # local build via extracted pack
 *   node scripts/desktop-install.mjs npm
 *   node scripts/desktop-install.mjs npm 0.3.2
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2]
const versionArg = process.argv[3]
if (mode !== 'link' && mode !== 'npm') {
  console.error('Usage: node scripts/desktop-install.mjs <link|npm> [version]')
  process.exit(1)
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', 'desktop')
const profilePkgPath = join(profileDir, 'package.json')
const profilePatchPath = join(profileDir, 'cordis.patch.yml')
const profileLockPath = join(profileDir, 'pnpm-lock.yaml')
const modulePath = join(profileDir, 'node_modules', 'dsh-agent-enhancer')
const packDir = join(profileDir, '.dsh-enhancer-pack')
const extractDir = join(packDir, 'pkg')

if (!existsSync(profilePkgPath)) {
  console.error(`Desktop profile not found: ${profilePkgPath}`)
  process.exit(1)
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: true })
}

function runCapture(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
}

function packTarballName(cwd) {
  const out = runCapture('corepack', ['pnpm', 'pack'], cwd)
  const lines = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const named = lines.find((line) => /^dsh-agent-enhancer-.*\.tgz$/.test(line))
    ?? lines.find((line) => line.endsWith('.tgz'))
  if (!named) {
    console.error('pnpm pack did not report a .tgz name')
    process.exit(1)
  }
  return named
}

function removeEnhancerModule() {
  if (!existsSync(modulePath)) return
  const stat = lstatSync(modulePath)
  let real = modulePath
  try {
    real = realpathSync(modulePath)
  } catch {
    // dangling link
  }
  const repo = resolve(repoRoot)
  const resolved = resolve(real)
  const pointsAtRepo = resolved === repo
    || resolved.startsWith(`${repo}\\`)
    || resolved.startsWith(`${repo}/`)

  if (stat.isSymbolicLink() || pointsAtRepo) {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'rmdir', modulePath], { stdio: 'inherit' })
      return
    }
    rmSync(modulePath, { force: true })
    return
  }

  rmSync(modulePath, { force: true, recursive: true, maxRetries: 5 })
}

/** Drop sticky link: lock entries so pnpm re-resolves the new local path. */
function clearEnhancerLockEntry() {
  if (!existsSync(profileLockPath)) return
  let text = readFileSync(profileLockPath, 'utf8').replace(/\r\n/g, '\n')
  const next = text.replace(
    / {6}dsh-agent-enhancer:\n {8}specifier: .*\n {8}version: .*\n/,
    '',
  )
  if (next !== text) {
    writeFileSync(profileLockPath, next, 'utf8')
    console.log('pnpm-lock.yaml: cleared sticky dsh-agent-enhancer entry')
  }
}

/**
 * Do NOT insert agent-enhancer in the profile patch. The package
 * `cordis.patch.yml` already inserts it via the bundle layer. A second profile
 * insert creates two rows with the same id; ConfigEditor then `find`s the first
 * (no config) and refuses settings writes with
 * 「overridden by a home patch or command-line overlay」.
 *
 * Also strip disabled-only overrides. Leave any existing `config:` row
 * (saved model picks) untouched.
 */
function ensurePatchEnabled() {
  let text = existsSync(profilePatchPath) ? readFileSync(profilePatchPath, 'utf8') : ''
  text = text.replace(/\r\n/g, '\n')
  text = text.replace(/- insert:\n(?:[ \t]*\n)+/g, '')
  // Drop profile inserts that re-add the enhancer (bundle already inserts).
  text = text.replace(/- insert:\n(?: {2,}.+\n)+/g, (block) => (
    /dsh-agent-enhancer|id: agent-enhancer/.test(block) ? '' : block
  ))
  // Drop disabled-only override rows (no config).
  text = text.replace(
    /- id: agent-enhancer\n(?:  disabled: .*\n)+(?!(?:  config:|  name:))/g,
    '',
  )
  text = text.replace(/\n{3,}/g, '\n\n')
  if (!text.endsWith('\n') && text.length > 0) text += '\n'
  writeFileSync(profilePatchPath, text, 'utf8')
  console.log('cordis.patch.yml: no profile insert/disabled for agent-enhancer (bundle owns insert)')
}

function extractLocalPack() {
  run('corepack', ['pnpm', 'build'], repoRoot)
  const packedName = packTarballName(repoRoot)
  const packedPath = join(repoRoot, packedName)
  if (!existsSync(packedPath)) {
    console.error(`pnpm pack did not produce ${packedPath}`)
    process.exit(1)
  }

  rmSync(packDir, { force: true, recursive: true, maxRetries: 5 })
  mkdirSync(packDir, { recursive: true })
  const tgzDest = join(packDir, packedName)
  copyFileSync(packedPath, tgzDest)
  rmSync(packedPath, { force: true })

  // Extract package/ contents into pack/pkg (no repo node_modules).
  mkdirSync(extractDir, { recursive: true })
  run('tar', ['-xzf', tgzDest, '-C', packDir], profileDir)
  const nested = join(packDir, 'package')
  if (!existsSync(nested)) {
    console.error(`tarball extract missing ${nested}`)
    process.exit(1)
  }
  // Move package/* → pkg/
  rmSync(extractDir, { force: true, recursive: true, maxRetries: 5 })
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'move', nested, extractDir], { stdio: 'inherit' })
  } else {
    execFileSync('mv', [nested, extractDir], { stdio: 'inherit' })
  }

  if (existsSync(join(extractDir, 'node_modules'))) {
    console.error('Extracted pack unexpectedly contains node_modules')
    process.exit(1)
  }
  console.log(`extracted local build -> ${extractDir}`)
  return extractDir
}

const profile = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
profile.dependencies ??= {}
profile.dsh ??= {}
profile.dsh.profile ??= {}
const bundles = Array.isArray(profile.dsh.profile.bundles) ? [...profile.dsh.profile.bundles] : []
if (!bundles.includes('dsh-agent-enhancer')) bundles.push('dsh-agent-enhancer')
profile.dsh.profile.bundles = bundles

removeEnhancerModule()
clearEnhancerLockEntry()

let nextDep
if (mode === 'link') {
  const localPkg = extractLocalPack()
  nextDep = `file:${localPkg.replaceAll('\\', '/')}`
} else {
  rmSync(packDir, { force: true, recursive: true, maxRetries: 5 })
  nextDep = versionArg ?? repoPkg.version
}

profile.dependencies['dsh-agent-enhancer'] = nextDep
writeFileSync(profilePkgPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
console.log(`profile dependency -> ${nextDep}`)
ensurePatchEnabled()

console.log('forcing profile pnpm install for dsh-agent-enhancer…')
run('corepack', ['pnpm', 'install', '--force', '--config.confirmModulesPurge=false'], profileDir)

if (!existsSync(modulePath)) {
  console.error(`Install did not create ${modulePath}`)
  process.exit(1)
}

if (mode === 'link') {
  let real = modulePath
  try {
    real = realpathSync(modulePath)
  } catch {
    // ignore
  }
  const repo = resolve(repoRoot)
  const resolved = resolve(real)
  const pointsAtRepo = resolved === repo
    || resolved.startsWith(`${repo}\\`)
    || resolved.startsWith(`${repo}/`)
  const nestedSession = join(modulePath, 'node_modules', '@deepseek-ai', 'dsh-session')
  const nestedViaReal = join(resolved, 'node_modules', '@deepseek-ai', 'dsh-session')
  if (pointsAtRepo || existsSync(nestedSession) || existsSync(nestedViaReal)) {
    console.error('Local install still resolves to the repo / embeds @deepseek-ai/dsh-session; aborting.')
    console.error(`module -> ${resolved}`)
    process.exit(1)
  }
}

run('dsh', ['plugin', '--profile', 'desktop', 'install'], profileDir)

console.log(mode === 'link'
  ? 'Installed extracted local build into desktop profile. Quit and restart Desktop.'
  : `Installed dsh-agent-enhancer@${nextDep} from npm. Quit and restart Desktop.`)
