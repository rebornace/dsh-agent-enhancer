import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { AuxiliaryError } from '../../errors.ts'

export function mcpConnectorsErrorMessage(
  error: unknown,
  t: TranslateNS<'agent-enhancer'>,
): string {
  if (error instanceof AuxiliaryError) {
    if (
      /(listMcpConnectors|upsertMcpConnector|setMcpConnectorEnabled|uninstallMcpConnector|installMcpFromNpx|installMcpFromGit|importMcpJson|listMcpConnectorTools) remote is unavailable/i
        .test(error.message)
    ) {
      return t('mcpConnectorsHostStale')
    }
    if (error.message.includes('already exists') || error.message.includes('already used')) {
      return t('mcpConnectorsForceOverwrite')
    }
    return error.message || t('mcpConnectorsFailed')
  }
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return t('mcpConnectorsFailed')
}
