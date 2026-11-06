import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { GuideArtworkFiles } from '@deepseek-ai/dsh-client-ui-primitives'

/** Same guide glyph family as official 工作区文件 (`GuideArtworkFiles`). */
export function ExtraFoldersGuideIcon(props: IconProps) {
  return <GuideArtworkFiles {...props} />
}
