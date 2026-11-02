import { describe, expect, it } from 'vitest'
import { composerLocales } from '../src/client/locales.ts'
import {
  auxiliaryUserInput,
  optimizeSystemPrompt,
  predictSystemPrompt,
  resolveUiLocale,
} from '../src/host/prompts.ts'

describe('ui locale packs', () => {
  it('keeps zh and en composer dictionaries on the same key set', () => {
    expect(Object.keys(composerLocales.zh).sort()).toEqual(Object.keys(composerLocales.en).sort())
  })

  it('maps Desktop locale ids onto zh/en prompt packs', () => {
    expect(resolveUiLocale('zh')).toBe('zh')
    expect(resolveUiLocale('zh-CN')).toBe('zh')
    expect(resolveUiLocale('en')).toBe('en')
    expect(resolveUiLocale('en-US')).toBe('en')
    expect(resolveUiLocale(undefined)).toBe('zh')
  })

  it('selects bilingual optimize/predict prompts and user wrappers', () => {
    expect(optimizeSystemPrompt('zh')).toContain('提示词改写器')
    expect(optimizeSystemPrompt('en')).toContain('prompt rewriter')
    expect(predictSystemPrompt('zh')).toContain('下一条用户提示词')
    expect(predictSystemPrompt('en')).toContain('next user prompt')
    expect(auxiliaryUserInput({
      operation: 'optimize',
      source: 'hello',
      context: [{ turn: 1, prompt: 'p', response: 'r' }],
    }, 'en')).toContain('Recent context')
    expect(auxiliaryUserInput({
      operation: 'predict',
      context: [{ turn: 2, prompt: 'p', response: 'r' }],
    }, 'zh')).toContain('轮次 2')
  })
})
