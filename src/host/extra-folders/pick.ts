import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { ExtraFoldersError } from './types.ts'

const execFileAsync = promisify(execFile)
const nodeRequire = createRequire(import.meta.url)

export interface PickDirectoryResult {
  /** Absolute path, or null when the user cancelled. */
  readonly path: string | null
}

async function pickViaElectron(): Promise<string | null | undefined> {
  try {
    // Soft-load Electron; types are not a package dependency of this plugin.
    const electron = nodeRequire('electron') as {
      readonly dialog?: {
        showOpenDialog(options: {
          readonly properties: readonly string[]
          readonly title?: string
        }): Promise<{ readonly canceled: boolean, readonly filePaths: readonly string[] }>
      }
    }
    if (electron.dialog === undefined || typeof electron.dialog.showOpenDialog !== 'function') {
      return undefined
    }
    const result = await electron.dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select folder',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    return typeof path === 'string' && path.trim() !== '' ? path : null
  } catch {
    return undefined
  }
}

async function pickViaWindowsForms(): Promise<string | null | undefined> {
  if (process.platform !== 'win32') return undefined
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = \'Select folder\'',
    '$dialog.ShowNewFolderButton = $true',
    '$result = $dialog.ShowDialog()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.Write($dialog.SelectedPath)',
    '}',
  ].join('; ')
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', script],
      { windowsHide: true, encoding: 'utf8', timeout: 120_000 },
    )
    const path = stdout.trim()
    return path === '' ? null : path
  } catch {
    return undefined
  }
}

async function pickViaOsascript(): Promise<string | null | undefined> {
  if (process.platform !== 'darwin') return undefined
  try {
    const { stdout } = await execFileAsync(
      'osascript',
      ['-e', 'POSIX path of (choose folder with prompt "Select folder")'],
      { encoding: 'utf8', timeout: 120_000 },
    )
    const path = stdout.trim().replace(/\/$/, '')
    return path === '' ? null : path
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/User canceled|(-128)/i.test(message)) return null
    return undefined
  }
}

async function pickViaZenity(): Promise<string | null | undefined> {
  if (process.platform === 'win32' || process.platform === 'darwin') return undefined
  try {
    const { stdout } = await execFileAsync(
      'zenity',
      ['--file-selection', '--directory', '--title=Select folder'],
      { encoding: 'utf8', timeout: 120_000 },
    )
    const path = stdout.trim()
    return path === '' ? null : path
  } catch (error) {
    const code = error !== null && typeof error === 'object'
      ? Reflect.get(error, 'code')
      : undefined
    // zenity returns 1 on cancel.
    if (code === 1) return null
    return undefined
  }
}

/** Open a native folder chooser; null = cancelled. */
export async function pickDirectoryNow(signal: AbortSignal): Promise<PickDirectoryResult> {
  signal.throwIfAborted()
  const attempts = [
    pickViaElectron,
    pickViaWindowsForms,
    pickViaOsascript,
    pickViaZenity,
  ]
  for (const attempt of attempts) {
    signal.throwIfAborted()
    const path = await attempt()
    if (path !== undefined) return { path }
  }
  throw new ExtraFoldersError(
    'FILE_EDIT_FAILED',
    'No directory picker is available in this environment',
  )
}
