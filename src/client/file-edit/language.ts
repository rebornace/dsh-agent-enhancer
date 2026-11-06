/** Map a workspace path to a Monaco language id. */
export function languageFromPath(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path
  const lower = base.toLowerCase()
  if (lower === 'dockerfile') return 'dockerfile'
  if (lower === 'makefile' || lower === 'gnumakefile') return 'makefile'
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : ''
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript'
    case 'json':
    case 'jsonc':
      return 'json'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'mdx':
      return 'mdx'
    case 'css':
      return 'css'
    case 'scss':
      return 'scss'
    case 'less':
      return 'less'
    case 'html':
    case 'htm':
      return 'html'
    case 'xml':
    case 'svg':
      return 'xml'
    case 'yml':
    case 'yaml':
      return 'yaml'
    case 'py':
      return 'python'
    case 'rs':
      return 'rust'
    case 'go':
      return 'go'
    case 'java':
      return 'java'
    case 'kt':
    case 'kts':
      return 'kotlin'
    case 'c':
    case 'h':
      return 'c'
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
    case 'hh':
      return 'cpp'
    case 'cs':
      return 'csharp'
    case 'php':
      return 'php'
    case 'rb':
      return 'ruby'
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell'
    case 'ps1':
      return 'powershell'
    case 'sql':
      return 'sql'
    case 'toml':
    case 'ini':
      return 'ini'
    case 'txt':
    case 'log':
      return 'plaintext'
    default:
      return 'plaintext'
  }
}

/**
 * AMD modules that register Monarch tokenizers / language modes for a language id.
 * Loaded explicitly so highlighting works with our local Monaco route (lazy
 * contribute alone often never arrives through the script bridge).
 */
export function monacoModulesForLanguage(languageId: string): readonly string[] {
  switch (languageId) {
    case 'plaintext':
    case '':
      return []
    case 'json':
      return ['vs/language/json/jsonMode']
    case 'html':
      return ['vs/language/html/htmlMode']
    case 'css':
    case 'scss':
    case 'less':
      return ['vs/language/css/cssMode']
    case 'typescript':
      return [
        'vs/basic-languages/typescript/typescript',
        'vs/language/typescript/tsMode',
      ]
    case 'javascript':
      return [
        'vs/basic-languages/javascript/javascript',
        'vs/language/typescript/tsMode',
      ]
    case 'c':
    case 'cpp':
      return ['vs/basic-languages/cpp/cpp']
    case 'shell':
      return ['vs/basic-languages/shell/shell']
    case 'ini':
      return ['vs/basic-languages/ini/ini']
    case 'dockerfile':
      return ['vs/basic-languages/dockerfile/dockerfile']
    case 'markdown':
      return ['vs/basic-languages/markdown/markdown']
    case 'mdx':
      return ['vs/basic-languages/mdx/mdx']
    case 'python':
    case 'rust':
    case 'go':
    case 'java':
    case 'kotlin':
    case 'csharp':
    case 'php':
    case 'ruby':
    case 'powershell':
    case 'sql':
    case 'xml':
    case 'yaml':
      return [`vs/basic-languages/${languageId}/${languageId}`]
    default:
      return [`vs/basic-languages/${languageId}/${languageId}`]
  }
}
