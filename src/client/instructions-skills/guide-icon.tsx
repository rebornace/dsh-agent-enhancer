import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconSkillOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/** Official skill glyph — peer of guide artwork sizing (default 36). */
export function InstructionsSkillsGuideIcon(props: IconProps) {
  const size = props.size ?? 36
  return <IconSkillOutlineRegular {...props} size={size} />
}
