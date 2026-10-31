import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type Occurrence = InputState['occurrences'][number]
export interface PromptEntry { readonly seq: number; readonly text: string }
export interface DraftGuard {
  readonly sessionId: SessionId
  readonly draftRev: number
}
export interface DraftSelection extends DraftGuard {
  readonly start: number
  readonly end: number
  readonly structured?: boolean
  readonly occurrences?: readonly Occurrence[]
}
export interface DraftSnapshot extends DraftSelection {
  readonly text: string
}
export type ComposerKey = 'up' | 'down' | 'tab' | 'enter' | 'escape' | 'search'
export interface KeyContext {
  readonly composing: boolean
  readonly systemLayerOpen: boolean
  readonly officialMenuOpen: boolean
  readonly atFirstLine: boolean
  readonly atLastLine: boolean
}
export interface DraftWriter {
  replace(text: string, selection: DraftSelection, segments?: readonly string[], source?: string): boolean
  setDraft(text: string, caret: number): void
}
export interface ModuleSwitches {
  history(): boolean
  optimize(): boolean
  predict(): boolean
}
