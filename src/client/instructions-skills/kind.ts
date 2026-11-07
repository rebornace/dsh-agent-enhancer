import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

export const INSTRUCTIONS_SKILLS_TAB_ID = 'dsh-agent-enhancer/instructions-skills'
export const INSTRUCTIONS_SKILLS_TAB_KIND = 'agent-enhancer-instructions-skills'

/** Left `sidebar.panellist` + `main` panel id (peers dsh-market). */
export const SKILLS_PANEL_ID = 'agent-enhancer-skills' as MainPanelId

export interface InstructionsSkillsTabParams {
  readonly sessionId: string
}
