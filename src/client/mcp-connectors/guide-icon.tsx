import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/** Link glyph — distinct from Plugins pinwheel (`IconPluginPinwheelOutlineRegular`). */
export function McpConnectorsGuideIcon(props: IconProps) {
  const size = props.size ?? 36
  return <IconLinkOutlineRegular {...props} size={size} />
}
