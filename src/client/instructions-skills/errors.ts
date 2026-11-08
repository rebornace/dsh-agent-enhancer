import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { AuxiliaryError } from '../../errors.ts'
import { isWindowsPathBusyError } from '../../host/instructions-skills/fs-access.ts'

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
  // Pure HTTP 404 archive outcomes are “repo missing”, not transport failure.
  if (
    /GitHub archive download failed/i.test(text)
    && /HTTP\s*404/i.test(text)
    && !/HTTP\s*50[234]|ECONNRESET|ETIMEDOUT|gateway timeout/i.test(text)
  ) {
    return false
  }
  if (/GitHub repository not found:/i.test(text)) return false
  return /git clone failed|archive download failed|Connection was reset|Recv failure|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network \/ proxy|HTTP\s*50[234]|gateway timeout|proxy/i
    .test(text)
}

/**
 * True only for explicit “repo missing” outcomes — not git/proxy noise.
 * Proxies often echo “repository not found” / 404 HTML even when GitHub is unreachable.
 */
export function isGithubRepoNotFound(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '')
  if (isNetworkInstallFailure(error)) return false
  // Host-authored message after every archive candidate returned HTTP 404.
  if (/GitHub repository not found:/i.test(text)) return true
  if (
    /GitHub archive download failed/i.test(text)
    && /HTTP\s*404/i.test(text)
    && !/HTTP\s*50[234]/i.test(text)
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
  // Prefer network/proxy over “repo not found” — Desktop Node fetch often bypasses
  // Windows system-proxy rule mode; failures surface as 502/504 or git clone noise.
  if (isNetworkInstallFailure(error)) return t('instructionsSkillsNetworkFailed')
  if (isGithubRepoNotFound(error)) return t('instructionsSkillsRepoNotFound')
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
        // Prefer host detail over the generic「没有权限」when it is actionable.
        const host = error.message.trim()
        if (
          host !== ''
          && !/^permission denied/i.test(host)
          && host !== t('instructionsSkillsDenied')
        ) {
          return host
        }
        return t('instructionsSkillsDenied')
      }
      case 'FILE_EDIT_FAILED': {
        if (isWindowsPathBusyError(error)) return t('instructionsSkillsRemoveBusy')
        return error.message || t('instructionsSkillsFailed')
      }
      default:
        return error.message || t('instructionsSkillsFailed')
    }
  }
  if (isWindowsPathBusyError(error)) return t('instructionsSkillsRemoveBusy')
  return error instanceof Error ? error.message : t('instructionsSkillsFailed')
}
