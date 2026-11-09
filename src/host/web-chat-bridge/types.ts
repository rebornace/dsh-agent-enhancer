export type WebChatRole = 'user' | 'assistant'

export interface WebChatTurn {
  readonly role: WebChatRole
  readonly text: string
}

export interface WebChatTranscript {
  readonly title: string
  readonly turns: readonly WebChatTurn[]
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
