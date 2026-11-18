import { describe, expect, it } from 'vitest'
import { isWindowsPathBusyError } from '../src/host/instructions-skills/fs-access.ts'
import { instructionsSkillsErrorMessage } from '../src/client/instructions-skills/errors.ts'
import { AuxiliaryError } from '../src/errors.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

describe('isWindowsPathBusyError', () => {
  it('detects EIO access-denied with mojibake Chinese message', () => {
    const error = Object.assign(
      new Error("EIO, ¾Ü¾ø·ÃÎÊ¡£ '\\\\?\\C:\\Users\\tester\\.agents\\skills\\demo'"),
      { code: 'EIO' },
    )
    expect(isWindowsPathBusyError(error)).toBe(true)
  })

  it('detects EPERM and localized 拒绝访问', () => {
    expect(isWindowsPathBusyError(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }))).toBe(true)
    expect(isWindowsPathBusyError(new Error('EIO, 拒绝访问。'))).toBe(true)
  })
})

describe('instructionsSkillsErrorMessage busy mapping', () => {
  const t: TranslateNS<'agent-enhancer'> = key => (
    key === 'instructionsSkillsRemoveBusy' ? 'BUSY' : key
  )

  it('maps raw EIO access-denied install failures to RemoveBusy', () => {
    const error = Object.assign(
      new Error("EIO, ¾Ü¾ø·ÃÎÊ¡£ '\\\\?\\C:\\Users\\tester\\.agents\\skills\\demo'"),
      { code: 'EIO' },
    )
    expect(instructionsSkillsErrorMessage(error, t)).toBe('BUSY')
  })

  it('maps AuxiliaryError FILE_EDIT_FAILED busy hints', () => {
    expect(instructionsSkillsErrorMessage(
      new AuxiliaryError('FILE_EDIT_FAILED', 'Failed to update demo: still present (EPERM / EIO / file in use — close skill preview)'),
      t,
    )).toBe('BUSY')
  })

  it('surfaces actionable FILE_DENIED host detail instead of generic denied', () => {
    const tDenied: TranslateNS<'agent-enhancer'> = key => (
      key === 'instructionsSkillsDenied' ? '没有权限访问该路径' : key
    )
    expect(instructionsSkillsErrorMessage(
      new AuxiliaryError('FILE_DENIED', 'Unrecognized git skill source: not-a-repo'),
      tDenied,
    )).toBe('Unrecognized git skill source: not-a-repo')
  })
})
