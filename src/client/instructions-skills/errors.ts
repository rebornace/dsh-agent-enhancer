import { AuxiliaryError } from '../../errors.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Host/RPC missing after client-only hot reload — NOT GitHub HTTP 404 from zipball.
 */
export function isHostStaleTransport(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '')
  if (/remote is unavailable|transport failure/i.test(text)) return true
  // Typert may surface missing methods as HTTP 404 *with* the method name.
  if (
    /HTTP\s*404/i.test(text)
    && /(installSkillFromGit|installSkillFromZip|uninstallSkill|listInstructionsSkills|readSkillDocument)/i
      .test(text)
  ) {
    return true
  }
  return false
}

export function isNetworkInstallFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '')
  return /git clone failed|archive download failed|Connection was reset|Recv failure|ECONNRESET|ETIMEDOUT|network \/ proxy/i
    .test(text)
}

export function isGithubRepoNotFound(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '')
  if (/GitHub repository not found/i.test(text)) return true
  if (/repository not found/i.test(text)) return true
  // All archive candidates 404'd — message still lists api.github.com / codeload URLs.
  if (
    /HTTP\s*404/i.test(text)
    && /(api\.github\.com|codeload\.github\.com)/i.test(text)
  ) {
    return true
  }
  return false
}

export function instructionsSkillsErrorMessage(
  error: unknown,
  t: TranslateNS<'agent-enhancer'>,
): string {
  if (isHostStaleTransport(error)) return t('instructionsSkillsHostStale')
  if (isGithubRepoNotFound(error)) return t('instructionsSkillsRepoNotFound')
  if (isNetworkInstallFailure(error)) return t('instructionsSkillsNetworkFailed')
  if (error instanceof AuxiliaryError) {
    switch (error.code) {
      case 'SESSION_CHANGED':
        return t('instructionsSkillsSessionChanged')
      case 'FILE_NOT_FOUND':
        if (isGithubRepoNotFound(error)) return t('instructionsSkillsRepoNotFound')
        return t('instructionsSkillsNotFound')
      case 'FILE_DENIED': {
        const detail = error.message.toLowerCase()
        if (detail.includes('kebab')) return t('instructionsSkillsInvalidName')
        if (detail.includes('already exists')) return t('instructionsSkillsForceOverwrite')
        if (detail.includes('managed install') || detail.includes('cannot be uninstalled')) {
          return t('instructionsSkillsUninstallDenied')
        }
        return t('instructionsSkillsDenied')
      }
      case 'FILE_EDIT_FAILED': {
        const detail = error.message.toLowerCase()
        if (
          detail.includes('eperm')
          || detail.includes('file in use')
          || detail.includes('still present')
          || detail.includes('operation not permitted')
        ) {
          return t('instructionsSkillsRemoveBusy')
        }
        return error.message || t('instructionsSkillsFailed')
      }
      default:
        return error.message || t('instructionsSkillsFailed')
    }
  }
  const raw = error instanceof Error ? error.message : String(error ?? '')
  if (/eperm|file in use|still present|operation not permitted/i.test(raw)) {
    return t('instructionsSkillsRemoveBusy')
  }
  return error instanceof Error ? error.message : t('instructionsSkillsFailed')
}
