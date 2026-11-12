/** Stable failure codes the client can localize. */
export type McpProbeFailureCode = 'url-expired' | 'generic'

/** Classify probe/connect failure text from remote MCP gateways. */
export function classifyMcpProbeFailure(message: string): McpProbeFailureCode {
  const lower = message.toLowerCase()
  if (
    lower.includes('url is expired')
    || lower.includes('url expired')
    || lower.includes('"url is expired"')
  ) {
    return 'url-expired'
  }
  return 'generic'
}

/** Host-side rewrite so wire text stays short and classifiable. */
export function rewriteMcpProbeFailure(message: string): string {
  const code = classifyMcpProbeFailure(message)
  switch (code) {
    case 'url-expired':
      return 'url-expired'
    case 'generic':
      return message
    default: {
      const _exhaustive: never = code
      return _exhaustive
    }
  }
}
