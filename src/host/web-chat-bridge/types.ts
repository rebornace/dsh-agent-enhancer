import type { WebChatRichMessage } from './fragments.ts'

export type WebChatRole = 'user' | 'assistant'

export interface WebChatTurn {
  readonly role: WebChatRole
  readonly text: string
}

export interface WebChatTranscript {
  readonly title: string
  /** Flat preview / DOM-capture turns. Always present for UI lists. */
  readonly turns: readonly WebChatTurn[]
  /**
   * Structured share / history_messages tree when available.
   * Import prefers this over flat `turns` for Session seed fidelity.
   */
  readonly messages?: readonly WebChatRichMessage[]
  /** Branch tip when the payload is a message tree; omit for linear lists. */
  readonly currentMessageId?: number | null
  readonly partial: boolean
  readonly source: {
    readonly kind: 'rendered-capture' | 'official-export' | 'share-link' | 'account-history'
    readonly url?: string
    readonly chatSessionId?: string
    readonly capturedAt: string
    readonly filename?: string
  }
}

export interface ParseWebChatExportInput {
  readonly filename: string
  readonly bytes: Buffer
}

/**
 * One conversation in the picker.
 * File exports include `transcript` up front; account-history rows resolve it lazily.
 */
export interface WebChatExportCatalogItem {
  readonly id: string
  readonly title: string
  readonly turnCount: number
  readonly preview: string
  readonly transcript?: WebChatTranscript
}

export interface AnalyzeWebChatExportResult {
  readonly items: readonly WebChatExportCatalogItem[]
  readonly truncated: boolean
}
