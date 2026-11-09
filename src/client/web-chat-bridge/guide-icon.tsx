import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/** Globe glyph — distinct from Skills / Connectors left-nav icons. */
export function WebChatBridgeGuideIcon(props: IconProps) {
  const size = props.size ?? 36
  return <IconGlobeOutlineRegular {...props} size={size} />
}
