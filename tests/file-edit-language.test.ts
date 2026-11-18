import { describe, expect, it } from 'vitest'
import { languageFromPath, monacoModulesForLanguage } from '../src/client/file-edit/language.ts'

describe('languageFromPath', () => {
  it('maps common extensions to Monaco language ids', () => {
    expect(languageFromPath('src/app.tsx')).toBe('typescript')
    expect(languageFromPath('lib/index.mjs')).toBe('javascript')
    expect(languageFromPath('data/config.json')).toBe('json')
    expect(languageFromPath('README.md')).toBe('markdown')
    expect(languageFromPath('styles/main.scss')).toBe('scss')
    expect(languageFromPath('script.py')).toBe('python')
    expect(languageFromPath('notes.txt')).toBe('plaintext')
  })
})

describe('monacoModulesForLanguage', () => {
  it('loads language modes for rich languages and basic tokenizers otherwise', () => {
    expect(monacoModulesForLanguage('json')).toEqual(['vs/language/json/jsonMode'])
    expect(monacoModulesForLanguage('typescript')).toContain('vs/basic-languages/typescript/typescript')
    expect(monacoModulesForLanguage('typescript')).toContain('vs/language/typescript/tsMode')
    expect(monacoModulesForLanguage('python')).toEqual(['vs/basic-languages/python/python'])
    expect(monacoModulesForLanguage('plaintext')).toEqual([])
  })
})
