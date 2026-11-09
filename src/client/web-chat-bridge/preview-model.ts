import type { ImportWebChatHistoryRequest } from '../../host/web-chat-bridge/import-session.ts'
import type { WebChatTranscript } from '../../host/web-chat-bridge/types.ts'
import type { WebChatWorkspaceRow } from '../../host/web-chat-bridge/import-session.ts'

export function pickDefaultWebChatWorkspace(
  items: readonly WebChatWorkspaceRow[],
): string | null {
  const first = items[0]
  return first === undefined ? null : first.id
}

export function buildWebChatImportRequest(
  workspaceId: string,
  transcript: WebChatTranscript,
): ImportWebChatHistoryRequest {
  return { workspaceId, transcript }
}

export function truncatePreviewTurnText(text: string, maxChars = 480): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars - 1)}…`
}
