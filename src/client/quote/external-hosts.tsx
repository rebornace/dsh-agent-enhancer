import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { DomQuoteHost } from './dom-host.tsx'
import { TerminalQuoteHost } from './terminal-host.tsx'

export interface QuoteExternalHostsProps {
  readonly t: TranslateNS<'agent-enhancer'>
}

/** Document-preview + terminal quote hosts outside the chat text-interaction slot. */
export function QuoteExternalHosts(props: QuoteExternalHostsProps) {
  return (
    <>
      <DomQuoteHost t={props.t} />
      <TerminalQuoteHost t={props.t} />
    </>
  )
}
