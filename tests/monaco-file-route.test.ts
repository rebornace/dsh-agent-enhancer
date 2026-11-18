import { describe, expect, it } from 'vitest'
import { monacoFileError } from '../src/host/file-edit/monaco.ts'

describe('monacoFileError', () => {
  it('accepts paths under the vs root with or without a vs/ prefix', () => {
    expect(monacoFileError('loader.js')).toBeNull()
    expect(monacoFileError('editor/editor.main.js')).toBeNull()
    expect(monacoFileError('basic-languages/typescript/typescript.js')).toBeNull()
    expect(monacoFileError('vs/loader.js')).toBeNull()
    expect(monacoFileError('vs/basic-languages/python/python.js')).toBeNull()
  })

  it('rejects traversal and absolute paths', () => {
    expect(monacoFileError('../loader.js')).toBe('invalid file')
    expect(monacoFileError('editor/../loader.js')).toBe('invalid file')
    expect(monacoFileError('/etc/passwd')).toBe('invalid file')
    expect(monacoFileError('C:/windows')).toBe('invalid file')
    expect(monacoFileError('')).toBe('missing file')
    expect(monacoFileError(null)).toBe('missing file')
  })
})
