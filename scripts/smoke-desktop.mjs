import { spawn } from 'node:child_process'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || process.argv[index + 1] === undefined) return undefined
  return process.argv[index + 1]
}

const executable = option('--executable') ?? process.env.DSH_DESKTOP_EXE
const rootArgument = option('--root')
const port = option('--port') ?? '9333'
const reuse = process.argv.includes('--reuse')
if (executable === undefined || rootArgument === undefined || !/^\d+$/.test(port)) {
  console.error('Usage: node scripts/smoke-desktop.mjs --executable <DeepSeek Harness.exe> --root <new-empty-directory> [--port 9333] [--reuse]')
  process.exit(2)
}

const root = resolve(rootArgument)
const home = resolve(root, 'home')
const userData = resolve(root, 'user-data')
const workspace = resolve(root, 'workspace')
await mkdir(root, { recursive: reuse })
await Promise.all([
  mkdir(home, { recursive: reuse }),
  mkdir(userData, { recursive: reuse }),
  mkdir(workspace, { recursive: reuse }),
])

const steps = `# Desktop smoke steps\n\n- Desktop executable: ${executable}\n- Isolated DSH_HOME: ${home}\n- Isolated user-data-dir: ${userData}\n- Workspace: ${workspace}\n- CDP: http://127.0.0.1:${port}\n\nInstall the packed plugin into this isolated home with the desktop profile before launching.\nUse real Desktop UI automation where possible. Record visual/model-quality/IME judgments as 手动.\nDo not substitute synthetic model responses, synthetic IME results, jsdom, or a web profile.\n\n1. Send three distinct prompts. Exercise multiline cursor movement, history round-trip, Esc, and Alt+R / Ctrl+R.\n2. Verify real Chinese IME composition keys and official /model, /, and @ menu priority.\n3. Verify optimize, undo, Host request counts, edit invalidation, and selection preservation.\n4. Verify pending-response guards, offline/model failure, and manual-only retry.\n5. Verify one prediction, Tab-without-send, invalidation, and silent failure.\n6. Verify third-party hints, independent module switches, complete removal, and official behavior afterward.\n7. Inspect exact optimize/predict session-event audits, absence of chat cards, and absence of telemetry.\n8. Manually review real-model samples for Chinese ambiguity, English technical content, paths/code/constraints, and a long selection.\n`
await writeFile(resolve(root, 'steps.md'), steps)
await writeFile(resolve(root, 'launch.json'), JSON.stringify({
  executable,
  home,
  userData,
  workspace,
  cdp: `http://127.0.0.1:${port}`,
}, null, 2) + '\n')

const log = await open(resolve(root, 'desktop.log'), 'a')
const child = spawn(executable, [
  `--user-data-dir=${userData}`,
  `--remote-debugging-port=${port}`,
  '--no-first-run',
  workspace,
], {
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', log.fd, log.fd],
})

console.log(`Desktop PID: ${child.pid}`)
console.log(`CDP: http://127.0.0.1:${port}`)
console.log(`Steps: ${resolve(root, 'steps.md')}`)
child.once('error', error => {
  console.error(error)
  process.exitCode = 1
})
child.once('exit', async (code, signal) => {
  await log.close()
  console.log(`Desktop exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
  if (code !== 0 && signal === null) process.exitCode = 1
})
