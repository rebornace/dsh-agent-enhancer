import type { WebChatTranscript } from '../../host/web-chat-bridge/types.ts'

/** Markdown shape accepted by host `parseWebChatExport` (`## User` / `## Assistant`). */
export function formatWebChatExportMarkdown(transcript: WebChatTranscript): string {
  const title = transcript.title.trim() || 'Exported chat'
  const parts: string[] = [`# ${title}`, '']
  for (const turn of transcript.turns) {
    const heading = turn.role === 'user' ? 'User' : 'Assistant'
    parts.push(`## ${heading}`, '', turn.text.trim(), '')
  }
  return `${parts.join('\n').trimEnd()}\n`
}

/** Safe download basename from a chat title. */
export function webChatExportFilename(title: string, capturedAt = new Date()): string {
  const base = title
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim() || 'web-chat'
  const stamp = capturedAt.toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `${base}-${stamp}.md`
}

/** Trigger a browser download of the transcript as Markdown. */
export function downloadWebChatExportMarkdown(transcript: WebChatTranscript): void {
  const markdown = formatWebChatExportMarkdown(transcript)
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = webChatExportFilename(transcript.title)
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
