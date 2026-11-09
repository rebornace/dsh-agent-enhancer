import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { GuideArtworkBrowser } from '@deepseek-ai/dsh-client-ui-primitives'

/** Same guide glyph family as official 浏览器 (`GuideArtworkBrowser`). */
export function BrowserAgentGuideIcon(props: IconProps) {
  return <GuideArtworkBrowser {...props} />
}
