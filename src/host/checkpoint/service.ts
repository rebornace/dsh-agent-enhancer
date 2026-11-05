import { randomUUID } from 'node:crypto'
import { MessageId, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import {
  isUndoShellCheckpoint,
  liveActivityStats,
  undoShellRanges,
  type LiveActivityStats,
} from './activity.ts'
import { blockingUnavailable } from './availability.ts'
import type { CheckpointRollbackScope, CheckpointUnavailable } from './availability.ts'
import { checkpointAtSeq, recoverTurnPrompt, resolveRollbackCut, synthesizeCheckpoint } from './capture.ts'
import { chainTrackedFiles } from './chain-files.ts'
import { CheckpointFileError, CheckpointFiles } from './files.ts'
import type { CheckpointFileOperations, FileConflict, RestoreDirection } from './files.ts'
import type { CheckpointStore } from './store.ts'
import type { Checkpoint, CheckpointGap, FileCheckpoint } from './types.ts'
import type { SessionCut, SessionCutStore } from './cut-store.ts'
import { syncCutCache } from './cut-live.ts'
export type { CheckpointGap }
import {
  indexOfRollbackPrefix,
  isRollbackId,
  isUndoId,
  LEGACY_ROLLBACK_PREFIX,
  ROLLBACK_PREFIX,
  turnFromRollbackId,
  UNDO_PREFIX,
} from '../../identity.ts'

export type { CheckpointRollbackScope, CheckpointUnavailable } from './availability.ts'
export { blockingUnavailable, isConversationSoftUnavailable } from './availability.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'checkpoint-rollback': {
      kind: 'checkpoint-rollback'
      form: 'notice'
      summary: string
    }
  }
}

const surfaceEventTypes = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

type SurfaceMessageEvent = SessionEvent<'system/message' | 'developer/message' | 'user/message' | 'assistant/message' | 'tool/result'>

export type CheckpointRollbackOperation = 'rollback' | 'undo'

export interface CheckpointRollbackRequest {
  readonly sessionId: SessionId
  readonly turn: number
  /** Stable log pin when turn numbers reuse after undo/restore. */
  readonly atSeq?: number
  readonly operation?: CheckpointRollbackOperation
  readonly scope?: CheckpointRollbackScope
}

export interface CheckpointMessagePreview {
  readonly seq: number
  readonly type: string
  readonly text: string
}

export interface CheckpointFilePreview {
  readonly path: string
  readonly change: 'create' | 'modify' | 'delete'
}

/** Lightweight per-turn checkpoint card for Client affordances (no file bodies). */
export interface CheckpointTurnSummary {
  readonly turn: number
  readonly coverage: 'complete' | 'partial'
  readonly fileCount: number
  readonly createdAt: number
  /** Cut seq used as a stable history key when the live chat no longer shows the prompt. */
  readonly atSeq: number
  /** Full prompt text for history reuse after rollback (may be empty). */
  readonly prompt: string
  /** Truncated prompt text for timeline scanning (may be empty). */
  readonly promptPreview: string
  readonly files: readonly CheckpointFilePreview[]
  readonly gaps: readonly CheckpointGap[]
  /** True when an active restore tip currently hides this turn in chat. */
  readonly rolledBack: boolean
  /** True when this turn is the live restore tip (cut before this turn). */
  readonly tip: boolean
}

export interface CheckpointCutView {
  readonly hideTurnsFrom: number
  readonly cutSeq: number
  readonly restoredAtSeq: number
  readonly draftPrompt: string
  readonly scope: CheckpointRollbackScope
}

export interface CheckpointCutRequest {
  readonly sessionId: SessionId
}

export interface CheckpointCutResult {
  readonly sessionId: SessionId
  readonly cut: CheckpointCutView | null
}

export interface CheckpointSummariesRequest {
  readonly sessionId: SessionId
}

export interface CheckpointSummariesResult {
  readonly sessionId: SessionId
  /**
   * Surface-scoped counts for the composer gauge / timeline header.
   * Undo-shell captures are excluded from `checkpoints` / `liveCheckpoints`.
   */
  readonly activity: LiveActivityStats
  readonly turns: readonly CheckpointTurnSummary[]
}

export type { LiveActivityStats }

const PROMPT_PREVIEW_MAX = 96

export function checkpointPromptPreview(prompt: string, max = PROMPT_PREVIEW_MAX): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export function toCheckpointTurnSummary(
  checkpoint: Checkpoint,
  options: {
    readonly rolledBack?: boolean
    readonly tip?: boolean
    /** Prefer this when the stored checkpoint left prompt empty (mixed media, older captures). */
    readonly recoveredPrompt?: string
  } = {},
): CheckpointTurnSummary {
  const rolledBack = options.rolledBack ?? false
  const tip = options.tip ?? false
  const recovered = options.recoveredPrompt?.trim() ?? ''
  const prompt = checkpoint.prompt.trim() !== '' ? checkpoint.prompt : recovered
  const gaps = prompt.trim() === ''
    ? checkpoint.gaps
    : checkpoint.gaps.filter(gap => !(gap.type === 'prompt' && gap.reason === 'non-text-content'))
  return {
    turn: checkpoint.turn,
    coverage: gaps.length === 0 ? 'complete' : 'partial',
    fileCount: checkpoint.files.length,
    createdAt: checkpoint.createdAt,
    atSeq: checkpoint.atSeq,
    prompt,
    promptPreview: checkpointPromptPreview(prompt),
    files: checkpoint.files.map(file => ({ path: file.path, change: file.change })),
    gaps,
    rolledBack,
    tip,
  }
}

/** Timeline row for a closed log turn when no checkpoint file exists yet. */
export function summaryFromClosedTurn(
  events: readonly SessionEvent[],
  turn: number,
  options: {
    readonly rolledBack?: boolean
    readonly tip?: boolean
    readonly now?: number
  } = {},
): CheckpointTurnSummary | null {
  const turnStart = events.find(
    (event): event is SessionEvent<'turn/start'> =>
      event.type === 'turn/start' && event.data.turn === turn,
  )
  if (turnStart === undefined) return null
  const prompt = recoverTurnPrompt(events, turn)
  return {
    turn,
    coverage: 'complete',
    fileCount: 0,
    createdAt: options.now ?? Date.now(),
    atSeq: checkpointAtSeq(Number(turnStart.seq)),
    prompt,
    promptPreview: checkpointPromptPreview(prompt),
    files: [],
    gaps: [],
    rolledBack: options.rolledBack ?? false,
    tip: options.tip ?? false,
  }
}

export function cutViewOf(cut: SessionCut): CheckpointCutView {
  return {
    hideTurnsFrom: cut.hideTurnsFrom,
    cutSeq: cut.cutSeq,
    restoredAtSeq: cut.restoredAtSeq,
    draftPrompt: cut.draftPrompt,
    scope: cut.scope,
  }
}

/** Project a live cut into the tip-window shape summaries / transcript already understand. */
export function windowFromCut(cut: SessionCut | null | undefined): {
  readonly tipTurn: number
  readonly hideTurnsFrom: number
  readonly continueAfterSeq: number
} | undefined {
  if (cut === null || cut === undefined) return undefined
  return {
    tipTurn: cut.hideTurnsFrom,
    hideTurnsFrom: cut.hideTurnsFrom,
    continueAfterSeq: cut.restoredAtSeq,
  }
}

export interface CheckpointRollbackPreview extends CheckpointRollbackRequest {
  readonly messages: readonly CheckpointMessagePreview[]
  readonly files: readonly CheckpointFilePreview[]
  readonly conflicts: readonly FileConflict[]
  readonly unavailable: readonly CheckpointUnavailable[]
  /**
   * Turn of the live restore tip when one is active. Undo must target this turn
   * (not a later rolled-back checkpoint the user browsed in the timeline).
   */
  readonly tipTurn?: number
}

export interface CheckpointRollbackResult extends CheckpointRollbackRequest {
  readonly draft: string
}

export type CheckpointRollbackErrorCode =
  | 'ROLLBACK_UNAVAILABLE'
  | 'ROLLBACK_CONFLICT'
  | 'ROLLBACK_FAILED'
  | 'ROLLBACK_RECOVERY_FAILED'

export class CheckpointRollbackError extends Error {
  constructor(
    readonly code: CheckpointRollbackErrorCode,
    readonly unavailable: readonly CheckpointUnavailable[] = [],
    readonly conflicts: readonly FileConflict[] = [],
  ) {
    super(code)
    this.name = 'CheckpointRollbackError'
  }
}

export interface CheckpointServiceSession {
  readonly session: Session
  readonly workspaceRoot: string
  readonly status: 'idle' | 'running'
  readonly canRestore: boolean
  readEvents(): readonly SessionEvent[]
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  synchronize(signal: AbortSignal): Promise<void>
}

export interface CheckpointRollbackServiceOptions {
  readonly store: CheckpointStore
  readonly storageRoot: string
  readonly pluginVersion: string
  readonly resolveSession: (sessionId: SessionId) => CheckpointServiceSession | undefined
  readonly isEnabled?: () => boolean
  readonly operations?: CheckpointFileOperations
  readonly createId?: () => string
  readonly now?: () => number
  /** Wait for in-flight turn captures before reading the checkpoint store. */
  readonly awaitCaptures?: () => Promise<void>
  /** Per-session projection cut (hide turns after a restore without appending tip notices). */
  readonly cutStore?: SessionCutStore
  readonly cutCache?: Map<SessionId, SessionCut | null>
}

/** Cut-based restore plan — no tip append / undo shell on the DSH log. */
interface CutRollbackSurface {
  readonly operation: 'rollback'
  readonly turn: number
  readonly cutSeq: number
  readonly alreadyRestored: boolean
}

interface CutUndoSurface {
  readonly operation: 'undo'
  readonly tipTurn: number
  readonly live: SessionCut
  readonly restoreCut: SessionCut | null
}

interface Evaluation {
  readonly checkpoint: Checkpoint | null
  readonly adapter: CheckpointServiceSession | null
  readonly surface: CutRollbackSurface | CutUndoSurface | null
  readonly preview: CheckpointRollbackPreview
}

function rollbackMarkerId(turn: number, journalId: string, scope: CheckpointRollbackScope): MessageId {
  const tag = scope === 'conversation' ? 'c:' : ''
  return MessageId(`${ROLLBACK_PREFIX}${turn}:${tag}${journalId}`)
}

function undoCopyId(journalId: string, index: number): MessageId {
  return MessageId(`${UNDO_PREFIX}${journalId}:${index}`)
}

function rollbackIdOf(id: string): string {
  const start = indexOfRollbackPrefix(id)
  return start >= 0 ? id.slice(start) : id
}

function scopeOfMarkerId(id: string): CheckpointRollbackScope {
  const rolled = rollbackIdOf(id)
  for (const prefix of [ROLLBACK_PREFIX, LEGACY_ROLLBACK_PREFIX]) {
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+:c:`)
    if (pattern.test(rolled)) return 'conversation'
  }
  return 'conversation-and-files'
}

function scopeOfMarker(event: SessionEvent<'user/message'>): CheckpointRollbackScope {
  return scopeOfMarkerId(event.data.id)
}

function isRollbackMarker(event: SessionEvent | undefined, turn?: number): event is SessionEvent<'user/message'> {
  if (event?.type !== 'user/message' || event.data.source.kind !== 'checkpoint-rollback'
    || event.data.source.form !== 'notice' || event.data.content.length === 0) return false
  const prefixes = turn === undefined
    ? [ROLLBACK_PREFIX, LEGACY_ROLLBACK_PREFIX]
    : [`${ROLLBACK_PREFIX}${turn}:`, `${LEGACY_ROLLBACK_PREFIX}${turn}:`]
  if (prefixes.some(prefix => event.data.id.startsWith(prefix))) return true
  if (!isUndoId(event.data.id)) return false
  const original = indexOfRollbackPrefix(event.data.id)
  if (original < 0) return false
  const embedded = event.data.id.slice(original)
  return prefixes.some(prefix => embedded.startsWith(prefix))
}

function surfaceOpOf(
  event: SessionEvent,
): 'append' | { readonly op: 'replace', readonly startSeq: number, readonly endSeq: number } | undefined {
  const op = (event as { surfaceOp?: unknown }).surfaceOp
  if (op === 'append') return 'append'
  if (typeof op !== 'object' || op === null) return undefined
  const record = op as Record<string, unknown>
  if (record.op !== 'replace') return undefined
  if (typeof record.startSeq !== 'number' || typeof record.endSeq !== 'number') return undefined
  return { op: 'replace', startSeq: record.startSeq, endSeq: record.endSeq }
}

function markerStillActive(marker: SessionEvent, events: readonly SessionEvent[]): boolean {
  return !events.some(event => {
    if (event.seq <= marker.seq) return false
    const op = surfaceOpOf(event)
    return op !== undefined && op !== 'append' && op.startSeq <= marker.seq && op.endSeq >= marker.seq
  })
}

/**
 * Active restore tip window used to mark which stored turns are currently rolled back.
 *
 * Mature agents (Claude Code / Cline / Roo) only treat checkpoints in the *live*
 * transcript as restorable tips. When `surfaceNodes` is provided, off-surface
 * orphan markers (Desktop dropped the notice without covering the log seq) are
 * ignored so undo/restore is not trapped by a phantom tip.
 */
export function activeRollbackWindow(
  events: readonly SessionEvent[],
  surfaceNodes?: readonly number[],
): {
  /** Checkpoint turn the tip cut sits on (that turn is withdrawn). */
  readonly tipTurn: number
  /** First hidden turn — same as tipTurn for before-N restore. */
  readonly hideTurnsFrom: number
  readonly continueAfterSeq: number
} | undefined {
  const onSurface = surfaceNodes === undefined
    ? undefined
    : new Set(surfaceNodes.map(node => Number(node)))
  let tipTurn: number | undefined
  let continueAfterSeq: number | undefined
  for (const event of events) {
    if (!isRollbackMarker(event) || !markerStillActive(event, events)) continue
    if (onSurface !== undefined && !onSurface.has(Number(event.seq))) continue
    const turn = turnFromRollbackId(event.data.id)
    if (turn === undefined) continue
    tipTurn = tipTurn === undefined ? turn : Math.min(tipTurn, turn)
    continueAfterSeq = continueAfterSeq === undefined
      ? Number(event.seq)
      : Math.max(continueAfterSeq, Number(event.seq))
  }
  if (tipTurn === undefined || continueAfterSeq === undefined) return undefined
  return { tipTurn, hideTurnsFrom: tipTurn, continueAfterSeq }
}

export function isRolledBackCheckpoint(
  turn: number,
  atSeq: number,
  window: { readonly hideTurnsFrom: number, readonly continueAfterSeq: number } | undefined,
): boolean {
  if (window === undefined || turn < window.hideTurnsFrom) return false
  // atSeq is turnStart.seq - 1; fresh turns after the tip have atSeq >= continueAfterSeq.
  return atSeq < window.continueAfterSeq
}

function surfaceMessageId(event: SessionEvent): MessageId | null {
  switch (event.type) {
    case 'user/message': return event.data.id
    case 'system/message':
    case 'developer/message':
    case 'assistant/message':
    case 'tool/result': return event.data.message.id
    default: return null
  }
}

function isUndoCopy(event: SessionEvent): boolean {
  const id = surfaceMessageId(event)
  return id !== null && isUndoId(id)
}

function isUndoCopyAt(event: SessionEvent, expected: MessageId): boolean {
  const id = surfaceMessageId(event)
  return id === expected || (id?.startsWith(`${expected}:`) ?? false)
}

function logicalSeq(event: SessionEvent): SessionSeq {
  if (isUndoCopy(event)) {
    const match = surfaceMessageId(event)?.match(/:(\d+)(?::dsh-(?:agent|composer)-enhancer:rollback:.*)?$/)
    if (match !== null && match !== undefined) return SessionSeq(Number(match[1]))
  }
  return event.seq
}

function isOwnReplacement(event: SessionEvent): boolean {
  return isRollbackMarker(event) || isUndoCopy(event)
}

/**
 * Desktop appends the protected system prompt after `turn/start` (during step prep).
 * Session forbids replacing that node with a user/message marker — rolling it back
 * always fails with a surface-replace error. Keep system prompts on the surface.
 */
function isProtectedSystemMessage(event: SessionEvent | undefined): boolean {
  return event?.type === 'system/message'
}

function rollbackSurfaceNodes(
  events: readonly SessionEvent[],
  candidates: readonly SessionSeq[],
): SessionSeq[] {
  return candidates.filter(node => !isProtectedSystemMessage(events[node]))
}

/**
 * True when the live tip is exactly this cut and the only surface nodes past the
 * cut are restore markers — re-applying would only replace the notice with an
 * identical notice.
 */
export function isAlreadyRestoredRollback(
  events: readonly SessionEvent[],
  nodes: readonly SessionSeq[],
  turn: number,
  surfaceNodes?: readonly number[],
): boolean {
  if (nodes.length === 0) return false
  if (!nodes.every(node => isRollbackMarker(events[node]))) return false
  const window = activeRollbackWindow(events, surfaceNodes)
  return window !== undefined && turn === window.tipTurn
}

/**
 * Previously blocked restore-to-later while an earlier tip was live. That forced
 * full tip-undo (resurrecting every withdrawn turn). Later checkpoints now use
 * restore-forward instead — always false.
 */
export function isCoveredByEarlierRestore(
  _events: readonly SessionEvent[],
  _nodes: readonly SessionSeq[],
  _turn: number,
  _surfaceNodes?: readonly number[],
): boolean {
  return false
}

function abortError(): DOMException {
  return new DOMException('Checkpoint rollback was cancelled', 'AbortError')
}

function textOf(event: SessionEvent): string {
  switch (event.type) {
    case 'user/message':
      return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    case 'system/message':
    case 'developer/message':
    case 'assistant/message':
    case 'tool/result':
      return event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    default: return ''
  }
}

function operationOf(request: CheckpointRollbackRequest): CheckpointRollbackOperation {
  return request.operation ?? 'rollback'
}

function scopeOf(request: CheckpointRollbackRequest): CheckpointRollbackScope {
  return request.scope ?? 'conversation-and-files'
}

function directionOf(operation: CheckpointRollbackOperation): RestoreDirection {
  return operation === 'rollback' ? 'rollback' : 'undo'
}

/** Turn that owns a log seq (last turn/start at or before that seq). */
function turnOwningSeq(events: readonly SessionEvent[], seq: number): number | undefined {
  let current: number | undefined
  for (const event of events) {
    if (Number(event.seq) > seq) break
    if (event.type === 'turn/start') current = event.data.turn
  }
  return current
}

/**
 * Logical turn for peel/undo. Undo copies live under a new monotonic shell turn;
 * attribute them by the embedded original seq so "undo tip 3" peels turn 3 content
 * even when the shell is turn 5+.
 */
function logicalTurnOwning(events: readonly SessionEvent[], event: SessionEvent): number | undefined {
  return turnOwningSeq(events, Number(logicalSeq(event)))
}

function sourceEvents(
  events: readonly SessionEvent[],
  marker: SessionEvent<'user/message'>,
): readonly SurfaceMessageEvent[] | null {
  // Single-seq append that points at an older tip — follow the chain.
  if (marker.surfaceOp === 'append' && marker.sourceEventSeqs?.length === 1) {
    const original = events[marker.sourceEventSeqs[0]!]
    if (isRollbackMarker(original)) return sourceEvents(events, original)
  }
  if (marker.sourceEventSeqs === undefined || marker.sourceEventSeqs.length === 0) return null
  const sources: SurfaceMessageEvent[] = []
  for (const seq of marker.sourceEventSeqs) {
    const event = events[seq]
    if (event === undefined) return null
    // Earlier restore while a tip is live replaces that tip notice — expand its
    // withdrawn sources so undo can still peel turn-by-turn.
    if (isRollbackMarker(event)) {
      const nested = sourceEvents(events, event)
      if (nested === null) return null
      sources.push(...nested)
      continue
    }
    if (!surfaceEventTypes.has(event.type)) return null
    sources.push(event as SurfaceMessageEvent)
  }
  if (sources[0]?.type !== 'user/message') return null
  return sources
}

/** Peel the tip turn only; keep a next tip for anything still withdrawn. */
function peelUndoSources(
  events: readonly SessionEvent[],
  sources: readonly SurfaceMessageEvent[],
  tipTurn: number,
): {
  readonly undoSources: readonly SurfaceMessageEvent[]
  readonly nextTip: { readonly turn: number, readonly sources: readonly SurfaceMessageEvent[] } | undefined
} {
  const reappear = sources.filter(event => logicalTurnOwning(events, event) === tipTurn)
  const stillWithdraw = sources.filter(event => {
    const owned = logicalTurnOwning(events, event)
    return owned !== undefined && owned !== tipTurn
  })
  if (reappear.length === 0 || stillWithdraw.length === 0) {
    return { undoSources: sources, nextTip: undefined }
  }
  const nextTipTurn = stillWithdraw.reduce((min, event) => {
    const owned = logicalTurnOwning(events, event)
    return owned === undefined ? min : Math.min(min, owned)
  }, Number.POSITIVE_INFINITY)
  if (!Number.isFinite(nextTipTurn)) return { undoSources: sources, nextTip: undefined }
  return {
    undoSources: reappear,
    nextTip: { turn: nextTipTurn, sources: stillWithdraw },
  }
}

/**
 * Session format requires monotonic turn ids. Re-opening the rolled-back turn
 * fails on reload (`turn/start does not open the expected turn`). Undo opens
 * the next unused turn instead.
 */
function nextTurnNumber(events: readonly SessionEvent[]): number {
  let max = 0
  for (const event of events) {
    if (event.type === 'turn/start') max = Math.max(max, event.data.turn)
  }
  return max + 1
}

/** Turn opened for a partially appended undo (recovery resumes inside it). */
function undoTurnAfterMarker(
  events: readonly SessionEvent[],
  markerSeq: SessionSeq,
): number {
  for (const event of events) {
    if (Number(event.seq) > Number(markerSeq) && event.type === 'turn/start') {
      return event.data.turn
    }
  }
  throw new Error('Partial undo is missing its turn/start')
}

/**
 * Live restore tip on the surface. Prefer the last active marker even when the
 * user continued chatting after restore (those nodes sit after the tip).
 * When `turn` is omitted, any live restore marker counts as the tip.
 */
function tipRollbackMarker(
  events: readonly SessionEvent[],
  nodes: readonly number[],
  turn?: number,
): SessionEvent<'user/message'> | undefined {
  let tip: SessionEvent<'user/message'> | undefined
  for (const node of nodes) {
    const event = events[node]
    if (!isRollbackMarker(event, turn) || !markerStillActive(event, events)) continue
    tip = event
  }
  return tip
}

/**
 * Last active restore tip in the append-only log (may briefly disagree with the
 * surface when Desktop rewrites projection). Prefer a marker that is still a
 * surface node so undo can replace it.
 */
function resolveUndoTipMarker(
  events: readonly SessionEvent[],
  nodes: readonly number[],
): SessionEvent<'user/message'> | undefined {
  const onSurface = tipRollbackMarker(events, nodes)
  if (onSurface !== undefined) return onSurface
  let tip: SessionEvent<'user/message'> | undefined
  for (const event of events) {
    if (!isRollbackMarker(event) || !markerStillActive(event, events)) continue
    tip = event
  }
  if (tip !== undefined && nodes.some(node => Number(node) === Number(tip!.seq))) return tip
  // Last resort: any rollback notice still on the surface (ignore still-active).
  // Desktop may cover the log marker with an unrecognized surface op while the
  // notice remains the live tip in the chat projection.
  let surfaceTip: SessionEvent<'user/message'> | undefined
  for (const node of nodes) {
    const event = events[node]
    if (isRollbackMarker(event)) surfaceTip = event
  }
  return surfaceTip
}

/**
 * Inclusive end seq for undoing the tip: the marker itself, or the last
 * non-protected surface node after it (post-restore continuation to withdraw).
 * Trailing protected system/developer prompts stay on the surface.
 */
function undoReplaceEndSeq(
  events: readonly SessionEvent[],
  nodes: readonly number[],
  markerSeq: SessionSeq,
): SessionSeq {
  const markerIndex = nodes.findIndex(node => Number(node) === Number(markerSeq))
  if (markerIndex < 0) return markerSeq
  let end = markerSeq
  for (let index = markerIndex + 1; index < nodes.length; index += 1) {
    const event = events[nodes[index]!]
    if (ignoreOnUndoKeepPrefix(event)) continue
    end = SessionSeq(nodes[index]!)
  }
  return end
}

/** Every surface node from tip marker through replace end, plus the restored source. */
function undoShadowedSourceSeqs(
  nodes: readonly number[],
  markerSeq: SessionSeq,
  replaceEndSeq: SessionSeq,
  sourceSeq: SessionSeq,
): SessionSeq[] {
  const seqs: SessionSeq[] = []
  let inRange = false
  for (const node of nodes) {
    if (Number(node) === Number(markerSeq)) inRange = true
    if (!inRange) continue
    seqs.push(SessionSeq(node))
    if (Number(node) === Number(replaceEndSeq)) break
  }
  if (!seqs.some(seq => Number(seq) === Number(sourceSeq))) seqs.push(sourceSeq)
  return seqs
}

function ignoreOnUndoKeepPrefix(event: SessionEvent | undefined): boolean {
  return isProtectedSystemMessage(event) || event?.type === 'developer/message'
}

interface UndoToolCall {
  readonly callId: ToolCallId
  readonly name: string
  readonly arguments: string
}

function toolCallsOf(event: SessionEvent<'assistant/message'>): readonly UndoToolCall[] {
  const calls: UndoToolCall[] = []
  for (const block of event.data.message.content) {
    if (block.type !== 'tool-call') continue
    calls.push({ callId: block.id, name: block.name, arguments: block.arguments })
  }
  return calls
}

/**
 * V4 format tracks tool lifecycle across the physical log: assistant advertises
 * a call, `tool/call` marks it started, `tool/result` settles it. Undo only
 * re-copies surface messages, so without synthetic `tool/call` rows a restored
 * `tool/result` looks like a not-started repair and fails reload validation
 * (`not-started error requires an object`).
 */
function appendUndoToolCalls(
  session: Session,
  calls: readonly UndoToolCall[],
  turn: number,
  step: number,
  openCalls: Map<string, UndoToolCall>,
): void {
  for (const call of calls) {
    session.append('tool/call', {
      turn,
      step,
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
    })
    openCalls.set(String(call.callId), call)
  }
}

function settleOpenUndoToolCalls(
  session: Session,
  journalId: string,
  turn: number,
  step: number,
  openCalls: Map<string, UndoToolCall>,
): void {
  for (const call of openCalls.values()) {
    session.append('tool/result', {
      turn,
      step,
      message: {
        id: MessageId(`${UNDO_PREFIX}${journalId}:orphan:${call.callId}`),
        role: 'tool',
        source: { kind: 'tool', callId: call.callId },
        toolCallId: call.callId,
        isError: true,
        content: [{
          type: 'text',
          text: 'The tool call was restored without a recorded result.',
        }],
      },
      error: {
        name: 'UndoOrphanToolCall',
        code: 'UNDO_ORPHAN_TOOL_CALL',
        reason: 'Restored assistant tool call had no matching tool/result in the rollback surface.',
      },
    }, { surfaceOp: 'append' })
  }
  openCalls.clear()
}

/**
 * After a crash mid-undo, assistant copies may already advertise tool calls
 * without their synthetic `tool/call` rows. Emit any missing starts before
 * resuming so the next `tool/result` copy is not treated as not-started.
 */
function ensureCopiedAssistantToolCalls(
  session: Session,
  events: readonly SessionEvent[],
  journalId: string,
  completed: number,
  turn: number,
  step: number,
  openCalls: Map<string, UndoToolCall>,
): void {
  const first = events.find(event => isUndoCopyAt(event, undoCopyId(journalId, 0)))
  if (first === undefined) return
  const undoStart = Number(first.seq)
  const started = new Set<string>()
  const settled = new Set<string>()
  for (const event of events) {
    if (Number(event.seq) < undoStart) continue
    if (event.type === 'tool/call') started.add(String(event.data.callId))
    if (event.type === 'tool/result') settled.add(String(event.data.message.toolCallId))
  }
  for (let index = 0; index < completed; index += 1) {
    const event = events.find(candidate => isUndoCopyAt(candidate, undoCopyId(journalId, index)))
    if (event?.type !== 'assistant/message') continue
    const calls = toolCallsOf(event)
    appendUndoToolCalls(
      session,
      calls.filter(call => !started.has(String(call.callId))),
      turn,
      step,
      openCalls,
    )
    for (const call of calls) {
      if (!settled.has(String(call.callId))) openCalls.set(String(call.callId), call)
    }
  }
}

/** Count contiguous undo copies from `first`, allowing synthetic `tool/call` gaps. */
function countPartialUndoCopies(
  events: readonly SessionEvent[],
  first: SessionEvent,
  journalId: string,
  tip: number,
): number {
  let completed = 0
  let cursor = Number(first.seq)
  while (cursor <= tip) {
    const event = events[SessionSeq(cursor)]
    if (event === undefined) throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
    if (isUndoCopyAt(event, undoCopyId(journalId, completed))) {
      completed += 1
      cursor += 1
      continue
    }
    if (event.type === 'tool/call' && completed > 0) {
      cursor += 1
      continue
    }
    throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
  }
  return completed
}

function appendUndoCopy(
  session: Session,
  source: SurfaceMessageEvent,
  journalId: string,
  index: number,
  tipMarkerSeq: SessionSeq,
  mode: 'replace' | 'append',
  replaceStartSeq: SessionSeq,
  replaceEndSeq: SessionSeq,
  turn: number,
  step: number,
  openCalls: Map<string, UndoToolCall>,
): SessionEvent {
  const copyId = MessageId(`${undoCopyId(journalId, index)}:${source.seq}`)
  const id = isRollbackMarker(source) ? MessageId(`${copyId}:${source.data.id}`) : copyId
  if (source.type === 'user/message') {
    if (mode === 'append' || index > 0) {
      return session.append('user/message', { ...source.data, id }, {
        surfaceOp: 'append',
        sourceEventSeqs: [source.seq],
      })
    }
    const shadowed = undoShadowedSourceSeqs(
      session.surface.nodes,
      replaceStartSeq,
      replaceEndSeq,
      source.seq,
    )
    // Keep the tip marker seq discoverable for crash recovery when it is off-surface.
    if (!shadowed.some(seq => Number(seq) === Number(tipMarkerSeq))) {
      shadowed.unshift(tipMarkerSeq)
    }
    return session.append('user/message', { ...source.data, id }, {
      surfaceOp: { op: 'replace', startSeq: replaceStartSeq, endSeq: replaceEndSeq },
      sourceEventSeqs: shadowed,
    })
  }
  if (index === 0 && mode === 'replace') {
    throw new Error('The first restored surface event must be a user message')
  }
  switch (source.type) {
    case 'assistant/message': {
      const event = session.append('assistant/message', {
        ...source.data,
        turn,
        step,
        message: { ...source.data.message, id },
      }, { surfaceOp: 'append' })
      appendUndoToolCalls(session, toolCallsOf(source), turn, step, openCalls)
      return event
    }
    case 'system/message':
      return session.append('system/message', {
        ...source.data,
        turn,
        step,
        message: { ...source.data.message, id },
      }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    case 'developer/message':
      return session.append('developer/message', {
        ...source.data,
        turn,
        step,
        message: { ...source.data.message, id },
      }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    case 'tool/result': {
      openCalls.delete(String(source.data.message.toolCallId))
      return session.append('tool/result', {
        ...source.data,
        turn,
        step,
        message: { ...source.data.message, id },
      }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    }
  }
}

export class CheckpointRollbackService {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private recovery: Promise<void> | undefined
  private closing: Promise<void> | undefined

  constructor(private readonly options: CheckpointRollbackServiceOptions) {}

  preview(request: CheckpointRollbackRequest, signal?: AbortSignal): Promise<CheckpointRollbackPreview> {
    return this.track(this.runPreview(request, signal))
  }

  execute(request: CheckpointRollbackRequest, signal?: AbortSignal): Promise<CheckpointRollbackResult> {
    return this.track(this.runExecute(request, signal))
  }

  summaries(
    request: CheckpointSummariesRequest,
    signal?: AbortSignal,
  ): Promise<CheckpointSummariesResult> {
    return this.track(this.runSummaries(request, signal))
  }

  getCut(
    request: CheckpointCutRequest,
    signal?: AbortSignal,
  ): Promise<CheckpointCutResult> {
    return this.track(this.runGetCut(request, signal))
  }

  recover(): Promise<void> {
    if (this.recovery !== undefined) return this.recovery
    const operation = this.track(this.runRecovery())
    this.recovery = operation
    return operation.finally(() => {
      if (this.recovery === operation) this.recovery = undefined
    })
  }

  close(): Promise<void> {
    if (this.closing === undefined) {
      this.lifetime.abort(abortError())
      this.closing = Promise.allSettled([...this.pending]).then(() => undefined)
    }
    return this.closing
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    return operation.finally(() => { this.pending.delete(operation) })
  }

  private linkedSignal(signals: readonly (AbortSignal | undefined)[]): {
    signal: AbortSignal
    cleanup: () => void
  } {
    const controller = new AbortController()
    const listeners: Array<{ signal: AbortSignal, abort: () => void }> = []
    for (const signal of [this.lifetime.signal, ...signals]) {
      if (signal === undefined) continue
      const abort = () => { controller.abort(signal.reason ?? abortError()) }
      if (signal.aborted) abort()
      else {
        signal.addEventListener('abort', abort, { once: true })
        listeners.push({ signal, abort })
      }
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        for (const { signal, abort } of listeners) signal.removeEventListener('abort', abort)
      },
    }
  }

  private async runPreview(
    request: CheckpointRollbackRequest,
    callerSignal?: AbortSignal,
  ): Promise<CheckpointRollbackPreview> {
    const linked = this.linkedSignal([callerSignal])
    try {
      linked.signal.throwIfAborted()
      // Pending journals must not dead-end preview into a false "恢复未完成".
      // Finish crash recovery first; only then block if recovery itself cannot run.
      if ((await this.options.store.listPendingJournals()).length > 0) {
        try {
          await this.recover()
        } catch {
          throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
        }
      }
      linked.signal.throwIfAborted()
      return (await this.evaluate(request)).preview
    } catch (error) {
      throw this.sanitize(error, linked.signal)
    } finally {
      linked.cleanup()
    }
  }

  private async runSummaries(
    request: CheckpointSummariesRequest,
    callerSignal?: AbortSignal,
  ): Promise<CheckpointSummariesResult> {
    const linked = this.linkedSignal([callerSignal])
    try {
      linked.signal.throwIfAborted()
      if (this.options.isEnabled?.() === false) {
        return {
          sessionId: request.sessionId,
          activity: { turns: 0, steps: 0, checkpoints: 0, liveCheckpoints: 0 },
          turns: [],
        }
      }
      await this.options.awaitCaptures?.()
      linked.signal.throwIfAborted()
      const checkpoints = await this.options.store.list(request.sessionId)
      const liveCut = await this.readCut(request.sessionId)
      const adapter = this.options.resolveSession(request.sessionId)
      const events = adapter?.readEvents() ?? []
      const surfaceNodes = adapter?.session.surface.nodes
      const tipWindow = events.length === 0
        ? undefined
        : activeRollbackWindow(events, surfaceNodes)
      const window = windowFromCut(liveCut) ?? tipWindow
      const shells = undoShellRanges(events)
      // Never drop file-bearing captures on a shell mis-detect — restart prune
      // previously wiped rollback snapshots, then soft backfill left files:[].
      const kept = events.length === 0
        ? checkpoints
        : checkpoints.filter(checkpoint => (
          checkpoint.files.length > 0 || !isUndoShellCheckpoint(checkpoint.atSeq, shells)
        ))
      // Persist the prune so undo-shell junk stops occupying the 20-slot cap /
      // shadowing real turns on the next preview.
      if (kept.length !== checkpoints.length) {
        await this.options.store.replace(request.sessionId, kept)
      }
      void this.options.store.purgeSettledJournals().catch(() => undefined)
      // Index by atSeq: turn numbers reuse after undo and must not collapse rows.
      const tipAtSeq = liveCut?.cutSeq
      const byAtSeq = new Map<number, CheckpointTurnSummary>()
      for (const checkpoint of kept) {
        const recoveredPrompt = checkpoint.prompt.trim() === ''
          ? recoverTurnPrompt(events, checkpoint.turn)
          : ''
        const rolledBack = isRolledBackCheckpoint(checkpoint.turn, checkpoint.atSeq, window)
        const tip = tipAtSeq !== undefined
          ? checkpoint.atSeq === tipAtSeq
          : window !== undefined && checkpoint.turn === window.tipTurn
        const summary = toCheckpointTurnSummary(checkpoint, {
          rolledBack,
          tip,
          recoveredPrompt,
        })
        const previous = byAtSeq.get(checkpoint.atSeq)
        // Identical atSeq is corrupt / legacy; keep the file-bearing row.
        if (previous !== undefined && previous.fileCount > 0 && summary.fileCount === 0) continue
        byAtSeq.set(checkpoint.atSeq, summary)
      }
      // Live capture can miss closed turns (reload races, agent.id≠session.id).
      // Synthesize conversation-only rows so the timeline matches visible chat.
      const live = adapter
      if (live != null && events.length > 0) {
        const closedStarts: SessionEvent<'turn/start'>[] = []
        for (let index = 0; index < events.length; index += 1) {
          const event = events[index]!
          if (event.type !== 'turn/start') continue
          const turn = event.data.turn
          const ended = events.slice(index + 1).some(item => (
            item.type === 'turn/end'
            && item.data.turn === turn
            && Number(item.seq) > Number(event.seq)
          ))
          if (ended) closedStarts.push(event)
        }
        const backfilled: Checkpoint[] = []
        for (const event of closedStarts) {
          const atSeq = checkpointAtSeq(Number(event.seq))
          if (byAtSeq.has(atSeq)) continue
          const soft = synthesizeCheckpoint({
            sessionId: request.sessionId,
            session: {
              format: live.session.header.version,
              preset: live.session.header.agentPreset ?? null,
            },
            pluginVersion: this.options.pluginVersion,
            turn: event.data.turn,
            events,
            createId: this.options.createId,
            now: this.options.now,
          })
          if (soft !== null) {
            if (isUndoShellCheckpoint(soft.atSeq, shells) && soft.atSeq === atSeq) continue
            // Pin soft atSeq to this turn/start — synthesize uses the first
            // matching turn number and lies after undo reuse.
            const pinned = soft.atSeq === atSeq ? soft : { ...soft, atSeq }
            if (isUndoShellCheckpoint(pinned.atSeq, shells)) continue
            backfilled.push(pinned)
            byAtSeq.set(
              atSeq,
              toCheckpointTurnSummary(pinned, {
                rolledBack: isRolledBackCheckpoint(pinned.turn, pinned.atSeq, window),
                tip: tipAtSeq !== undefined
                  ? pinned.atSeq === tipAtSeq
                  : window !== undefined && pinned.turn === window.tipTurn,
              }),
            )
            continue
          }
          // Contiguous-seq synthesize failed — still list the closed turn for UI.
          const row = summaryFromClosedTurn(events, event.data.turn, {
            rolledBack: isRolledBackCheckpoint(event.data.turn, atSeq, window),
            tip: tipAtSeq !== undefined
              ? atSeq === tipAtSeq
              : window !== undefined && event.data.turn === window.tipTurn,
            now: this.options.now?.(),
          })
          if (row !== null && !isUndoShellCheckpoint(atSeq, shells)) {
            byAtSeq.set(atSeq, { ...row, atSeq })
          }
        }
        for (const soft of backfilled) {
          try {
            await this.options.store.save(soft)
          } catch {
            // Timeline can still show the in-memory row if persist races.
          }
        }
      }
      // Conversation order by log position — turn ids alone lie after undo reuse.
      const turns = [...byAtSeq.values()].sort((left, right) => (
        left.atSeq - right.atSeq || left.turn - right.turn || left.createdAt - right.createdAt
      ))
      const liveCheckpoints = turns.filter(turn => !turn.rolledBack).length
      const activity = liveActivityStats(events, {
        hideTurnsFrom: window?.hideTurnsFrom,
        continueAfterSeq: window?.continueAfterSeq,
        checkpointCount: turns.length,
        liveCheckpointCount: liveCheckpoints,
      })
      return {
        sessionId: request.sessionId,
        activity,
        turns,
      }
    } catch (error) {
      throw this.sanitize(error, linked.signal)
    } finally {
      linked.cleanup()
    }
  }

  private async runGetCut(
    request: CheckpointCutRequest,
    callerSignal?: AbortSignal,
  ): Promise<CheckpointCutResult> {
    const linked = this.linkedSignal([callerSignal])
    try {
      linked.signal.throwIfAborted()
      const cut = await this.readCut(request.sessionId)
      return {
        sessionId: request.sessionId,
        cut: cut === null ? null : cutViewOf(cut),
      }
    } catch (error) {
      throw this.sanitize(error, linked.signal)
    } finally {
      linked.cleanup()
    }
  }

  private async readCut(sessionId: SessionId): Promise<SessionCut | null> {
    const cached = this.options.cutCache?.get(sessionId)
    if (cached !== undefined) return cached
    if (this.options.cutStore === undefined) return null
    const cut = await this.options.cutStore.get(sessionId)
    if (this.options.cutCache !== undefined) syncCutCache(this.options.cutCache, sessionId, cut)
    return cut
  }

  private async writeCut(sessionId: SessionId, cut: SessionCut | null): Promise<void> {
    if (this.options.cutStore === undefined) {
      throw new CheckpointRollbackError('ROLLBACK_FAILED')
    }
    await this.options.cutStore.set(sessionId, cut)
    if (this.options.cutCache !== undefined) syncCutCache(this.options.cutCache, sessionId, cut)
  }

  private async runExecute(
    request: CheckpointRollbackRequest,
    callerSignal?: AbortSignal,
  ): Promise<CheckpointRollbackResult> {
    const linked = this.linkedSignal([callerSignal])
    try {
      linked.signal.throwIfAborted()
      await this.options.store.recoverInterruptedWrites(request.sessionId)
      await this.recover()
      linked.signal.throwIfAborted()
      const initial = await this.evaluate(request)
      const initialScope = this.effectiveScope(request, initial)
      this.assertExecutable(initial, initialScope)
      const adapter = initial.adapter!
      const result = await adapter.runMaintenance(async maintenanceSignal => {
        const maintenance = this.linkedSignal([linked.signal, maintenanceSignal])
        try {
          maintenance.signal.throwIfAborted()
          // Inside maintenance the agent is often not "idle"; skip the running check.
          const current = await this.evaluate(request, { withinMaintenance: true })
          const scope = this.effectiveScope(request, current)
          this.assertExecutable(current, scope)
          // Same Session id is enough — object identity churns under maintenance.
          if (current.adapter?.session.id !== adapter.session.id || current.surface === null) {
            throw new CheckpointRollbackError('ROLLBACK_UNAVAILABLE', ['session-changed'])
          }
          const checkpoint = current.checkpoint!
          const operation = operationOf(request)
          const session = adapter.session
          const expectedSeq = Number(session.seq)
          const journalId = (this.options.createId ?? randomUUID)()
          const files = this.files(adapter, checkpoint, journalId)
          const surface = current.surface!
          const filesToRestore = scope === 'conversation'
            ? []
            : this.trackedFilesForRestore(
              await this.options.store.list(request.sessionId),
              adapter,
              surface,
              await this.readCut(request.sessionId),
            )
          const draftPrompt = checkpoint.prompt.trim() !== ''
            ? checkpoint.prompt
            : recoverTurnPrompt(adapter.readEvents(), request.turn)
          // Cut already matches and nothing to rewrite — return draft only.
          if (operation === 'rollback' && surface.operation === 'rollback'
            && surface.alreadyRestored && filesToRestore.length === 0) {
            return {
              sessionId: request.sessionId,
              turn: request.turn,
              draft: draftPrompt,
            }
          }
          // Cut-first (Claude Code / Cline): commit the conversation tip, then
          // restore files. Never restore files before the cut — a later cut miss
          // used to compensate and delete the just-restored file ("恢复未完成").
          if (maintenance.signal.aborted) {
            throw this.sanitize(abortError(), maintenance.signal)
          }
          if (adapter.session.id !== session.id
            || Number(adapter.session.seq) !== expectedSeq
            || !this.canCommit(adapter, scope)) {
            throw new CheckpointRollbackError('ROLLBACK_FAILED')
          }
          try {
            if (surface.operation === 'rollback') {
              const previous = await this.readCut(request.sessionId)
              const next: SessionCut = {
                hideTurnsFrom: surface.turn,
                cutSeq: surface.cutSeq,
                restoredAtSeq: expectedSeq,
                draftPrompt,
                scope,
                ...(filesToRestore.length > 0 ? { journalId } : {}),
                previous,
              }
              await this.writeCut(request.sessionId, next)
            } else {
              await this.writeCut(request.sessionId, surface.restoreCut)
            }
          } catch (error) {
            if (error instanceof CheckpointRollbackError) throw error
            throw new CheckpointRollbackError('ROLLBACK_FAILED')
          }
          const latest = this.options.resolveSession(request.sessionId)
          const syncTarget = latest !== undefined && latest.session.id === session.id
            ? latest
            : adapter
          try {
            await syncTarget.synchronize(maintenance.signal)
          } catch {
            // Projection sync is best-effort; the cut is already durable.
          }
          if (filesToRestore.length > 0) {
            // Surface already committed. Abort after files moved still compensates
            // disk only — the conversation cut stays (tip already restored).
            await files.runTransaction(filesToRestore, async () => {
              if (maintenance.signal.aborted) return { appended: false, synchronized: false }
              return { appended: true, synchronized: true }
            }, directionOf(operation))
          }
          return {
            sessionId: request.sessionId,
            turn: surface.operation === 'undo' ? surface.tipTurn : request.turn,
            draft: operation === 'rollback' ? draftPrompt : '',
          }
        } catch (error) {
          throw this.sanitize(error, maintenance.signal)
        } finally {
          maintenance.cleanup()
        }
      })
      // Re-project after the maintenance lock drops so client views are not held back.
      // The surface is already committed; a late projection miss must not undo success.
      linked.signal.throwIfAborted()
      try {
        await adapter.synchronize(linked.signal)
      } catch {
        if (linked.signal.aborted) throw this.sanitize(abortError(), linked.signal)
      }
      return result
    } catch (error) {
      throw this.sanitize(error, linked.signal)
    } finally {
      linked.cleanup()
    }
  }

  private async runRecovery(): Promise<void> {
    try {
      this.lifetime.signal.throwIfAborted()
      const journals = await this.options.store.recoverJournal()
      const sessionIds = [...new Set(journals.map(journal => journal.sessionId))]
      for (const sessionId of sessionIds) {
        await this.options.store.recoverInterruptedWrites(sessionId)
        const adapter = this.options.resolveSession(sessionId)
        if (adapter === undefined || adapter.status !== 'idle') {
          throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
        }
        await adapter.runMaintenance(async maintenanceSignal => {
          const linked = this.linkedSignal([maintenanceSignal])
          try {
            linked.signal.throwIfAborted()
            const files = new CheckpointFiles({
              workspaceRoot: adapter.workspaceRoot,
              storageRoot: this.options.storageRoot,
              store: this.options.store,
              sessionId,
              checkpointId: 'recovery',
              operations: this.options.operations,
              now: this.options.now,
            })
            await files.recoverFiles(async journal => {
              // Cut projection is the commit marker now — tip append is no longer required.
              const cut = await this.readCut(sessionId)
              return cut?.journalId === journal.id
            })
          } finally {
            linked.cleanup()
          }
        })
      }
    } catch (error) {
      if (error instanceof CheckpointRollbackError) throw error
      throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
    }
  }

  private async evaluate(
    request: CheckpointRollbackRequest,
    options: { readonly withinMaintenance?: boolean } = {},
  ): Promise<Evaluation> {
    const operation = operationOf(request)
    await this.options.awaitCaptures?.()
    const adapter = this.options.resolveSession(request.sessionId) ?? null
    const events = adapter?.readEvents() ?? []
    const shells = undoShellRanges(events)
    const checkpoints = await this.options.store.list(request.sessionId)
    // Prefer a real turn capture. Undo-shell rows share / steal turn ids and must
    // not satisfy restore/undo preview. When turn numbers reuse, pin by atSeq and
    // prefer file-bearing snapshots over empty soft backfills.
    const candidates = checkpoints.filter(checkpoint => (
      checkpoint.turn === request.turn
      && (checkpoint.files.length > 0 || !isUndoShellCheckpoint(checkpoint.atSeq, shells))
    ))
    let stored = (
      request.atSeq === undefined
        ? undefined
        : candidates.find(checkpoint => checkpoint.atSeq === request.atSeq)
    ) ?? candidates.find(checkpoint => checkpoint.files.length > 0)
      ?? candidates[0]
      ?? null
    // Cancelled / raced turns often have no store entry yet — synthesize a soft
    // conversation checkpoint from the closed turn so restore stays available.
    if (stored === null && adapter !== null && operation === 'rollback') {
      stored = synthesizeCheckpoint({
        sessionId: request.sessionId,
        session: {
          format: adapter.session.header.version,
          preset: adapter.session.header.agentPreset ?? null,
        },
        pluginVersion: this.options.pluginVersion,
        turn: request.turn,
        events: adapter.readEvents(),
        createId: this.options.createId,
        now: this.options.now,
      })
    }
    const unavailable: CheckpointUnavailable[] = []
    if (stored === null) unavailable.push('checkpoint-not-found')
    if (adapter === null) unavailable.push('session-changed')
    if (this.options.isEnabled !== undefined && !this.options.isEnabled()) unavailable.push('rollback-disabled')
    if (adapter !== null) {
      // Only an actively running agent blocks restore. Other non-idle statuses
      // (stopping / settling after cancel) must not disable confirm buttons.
      if (!options.withinMaintenance && adapter.status === 'running') unavailable.push('session-running')
      if (!adapter.canRestore) unavailable.push('permission-denied')
      if (adapter.session.header.origin === 'subagent' || (adapter.session.header.delegationDepth ?? 0) > 0) {
        unavailable.push('subagent-session')
      }
    }
    if (stored !== null) {
      if (stored.coverage !== 'complete' || stored.gaps.length > 0) unavailable.push('incomplete-checkpoint')
      for (const gap of stored.gaps) {
        unavailable.push(gap.type === 'prompt' ? 'prompt-non-text-content' : 'workspace-capture-failed')
      }
      // Only the Session format is a hard structural incompatibility. Plugin
      // version and agent preset drift are common after upgrades and must not
      // strand conversation restore.
      if (adapter !== null && stored.session.format !== adapter.session.header.version) {
        unavailable.push('incompatible-session')
      }
    }
    let messages: CheckpointMessagePreview[] = []
    let surface: CutRollbackSurface | CutUndoSurface | null = null
    const liveCut = await this.readCut(request.sessionId)
    if (stored !== null && adapter !== null && stored.atSeq >= 0) {
      const events = adapter.readEvents()
      const cut = resolveRollbackCut(events, stored.turn, stored.atSeq)
      if (cut === null) {
        unavailable.push('unknown-surface')
      } else if (operation === 'rollback') {
        if (events.some(event => Number(event.seq) > cut.cutSeq && typeof event.surfaceOp === 'object'
          && !isOwnReplacement(event))) {
          unavailable.push('compacted-surface')
        }
        const withdrawn = events.filter(event => (
          Number(event.seq) > cut.cutSeq
          && surfaceEventTypes.has(event.type)
          && !isProtectedSystemMessage(event)
        ))
        const alreadyRestored = liveCut !== null
          && liveCut.hideTurnsFrom === stored.turn
          && liveCut.cutSeq === cut.cutSeq
          && liveCut.restoredAtSeq === Number(adapter.session.seq)
        if (withdrawn.length === 0 || alreadyRestored) {
          unavailable.push('already-restored')
          surface = {
            operation,
            turn: stored.turn,
            cutSeq: cut.cutSeq,
            alreadyRestored: true,
          }
          messages = []
        } else {
          surface = {
            operation,
            turn: stored.turn,
            cutSeq: cut.cutSeq,
            alreadyRestored: false,
          }
          messages = withdrawn.map(event => ({
            seq: Number(event.seq),
            type: event.type,
            text: textOf(event),
          }))
        }
      } else if (liveCut === null) {
        // No live projection cut — nothing to undo (legacy tip-only sessions stay blocked).
        unavailable.push('session-changed')
      } else {
        const tipTurn = liveCut.hideTurnsFrom
        let undoStored = tipTurn === stored.turn
          ? stored
          : checkpoints.find(item => (
            item.turn === tipTurn && !isUndoShellCheckpoint(item.atSeq, shells)
          )) ?? null
        if (undoStored === null) {
          undoStored = synthesizeCheckpoint({
            sessionId: request.sessionId,
            session: {
              format: adapter.session.header.version,
              preset: adapter.session.header.agentPreset ?? null,
            },
            pluginVersion: this.options.pluginVersion,
            turn: tipTurn,
            events,
            createId: this.options.createId,
            now: this.options.now,
          })
        }
        if (undoStored === null) {
          unavailable.push('checkpoint-not-found')
        } else {
          if (tipTurn !== stored.turn) {
            const drop = new Set<CheckpointUnavailable>([
              'checkpoint-not-found',
              'incomplete-checkpoint',
              'prompt-non-text-content',
              'workspace-capture-failed',
              'incompatible-session',
            ])
            for (let index = unavailable.length - 1; index >= 0; index -= 1) {
              if (drop.has(unavailable[index]!)) unavailable.splice(index, 1)
            }
            if (undoStored.coverage !== 'complete' || undoStored.gaps.length > 0) {
              unavailable.push('incomplete-checkpoint')
              for (const gap of undoStored.gaps) {
                unavailable.push(gap.type === 'prompt' ? 'prompt-non-text-content' : 'workspace-capture-failed')
              }
            }
            if (undoStored.session.format !== adapter.session.header.version) {
              unavailable.push('incompatible-session')
            }
          }
          stored = undoStored
          surface = {
            operation,
            tipTurn,
            live: liveCut,
            restoreCut: liveCut.previous,
          }
          // Undo preview shows what the cut currently withdraws.
          messages = events
            .filter(event => (
              Number(event.seq) > liveCut.cutSeq
              && Number(event.seq) <= liveCut.restoredAtSeq
              && surfaceEventTypes.has(event.type)
              && !isProtectedSystemMessage(event)
            ))
            .map(event => ({
              seq: Number(event.seq),
              type: event.type,
              text: textOf(event),
            }))
        }
      }
    }
    const trackedFiles = stored === null || adapter === null || surface === null
      ? []
      : this.trackedFilesForRestore(checkpoints, adapter, surface, liveCut)
    let conflicts: readonly FileConflict[] = []
    if (stored !== null && adapter !== null) {
      try {
        conflicts = await this.files(adapter, stored, 'preview').verifyCurrent(trackedFiles, directionOf(operation))
      } catch (error) {
        if (error instanceof CheckpointFileError) conflicts = error.conflicts
        else throw error
      }
    }
    const cutWindow = windowFromCut(liveCut)
    const tipWindow = adapter !== null
      ? (cutWindow ?? activeRollbackWindow(adapter.readEvents(), adapter.session.surface.nodes))
      : undefined
    const previewTurn = surface?.operation === 'undo' ? surface.tipTurn : request.turn
    const undoScope = surface?.operation === 'undo' ? surface.live.scope : undefined
    return {
      checkpoint: stored,
      adapter,
      surface,
      preview: {
        sessionId: request.sessionId,
        turn: previewTurn,
        ...(stored === null ? {} : { atSeq: stored.atSeq }),
        ...(operation === 'undo' ? { operation } : {}),
        ...(undoScope === undefined ? {} : { scope: undoScope }),
        ...(tipWindow === undefined ? {} : { tipTurn: tipWindow.tipTurn }),
        messages,
        files: trackedFiles.map(file => ({ path: file.path, change: file.change })),
        conflicts,
        unavailable: [...new Set(unavailable)],
      },
    }
  }

  /**
   * Tracked text files for this restore/undo.
   * Rollback with no live cut: target turn → tip.
   * Rollback while a later cut is live: only the gap down to that tip (already restored).
   * Undo: reverse only the segment this tip added (down to previous tip, or open-ended).
   */
  private trackedFilesForRestore(
    checkpoints: readonly Checkpoint[],
    adapter: CheckpointServiceSession,
    surface: CutRollbackSurface | CutUndoSurface,
    liveCut: SessionCut | null,
  ): readonly FileCheckpoint[] {
    const shells = undoShellRanges(adapter.readEvents())
    const real = checkpoints.filter(checkpoint => (
      checkpoint.files.length > 0 || !isUndoShellCheckpoint(checkpoint.atSeq, shells)
    ))
    if (surface.operation === 'undo') {
      const previous = liveCut?.previous ?? null
      return chainTrackedFiles(real, {
        fromTurn: surface.tipTurn,
        fromAtSeq: surface.live.cutSeq,
        ...(previous !== null && previous.hideTurnsFrom > surface.tipTurn
          ? {
            untilTurnExclusive: previous.hideTurnsFrom,
            untilAtSeqExclusive: previous.cutSeq,
          }
          : {}),
      })
    }
    return chainTrackedFiles(real, {
      fromTurn: surface.turn,
      fromAtSeq: surface.cutSeq,
      ...(liveCut !== null && liveCut.hideTurnsFrom > surface.turn
        ? {
          untilTurnExclusive: liveCut.hideTurnsFrom,
          untilAtSeqExclusive: liveCut.cutSeq,
        }
        : {}),
    })
  }

  private effectiveScope(
    request: CheckpointRollbackRequest,
    evaluation: Evaluation,
  ): CheckpointRollbackScope {
    if (operationOf(request) === 'undo') {
      return evaluation.preview.scope ?? 'conversation-and-files'
    }
    return scopeOf(request)
  }

  private assertExecutable(evaluation: Evaluation, scope: CheckpointRollbackScope): void {
    const unavailable = blockingUnavailable(evaluation.preview.unavailable, scope, {
      trackedFiles: evaluation.preview.files.length,
    })
    if (unavailable.length > 0 || evaluation.surface === null) {
      throw new CheckpointRollbackError('ROLLBACK_UNAVAILABLE',
        unavailable.length > 0 ? unavailable : evaluation.preview.unavailable)
    }
    if (scope === 'conversation-and-files' && evaluation.preview.conflicts.length > 0) {
      throw new CheckpointRollbackError('ROLLBACK_CONFLICT', [], evaluation.preview.conflicts)
    }
  }

  private canCommit(adapter: CheckpointServiceSession, scope: CheckpointRollbackScope): boolean {
    if (!(this.options.isEnabled?.() ?? true)) return false
    // Conversation-only restore does not touch the workspace.
    return scope === 'conversation' || adapter.canRestore
  }

  private files(adapter: CheckpointServiceSession, checkpoint: Checkpoint, journalId: string): CheckpointFiles {
    return new CheckpointFiles({
      workspaceRoot: adapter.workspaceRoot,
      storageRoot: this.options.storageRoot,
      store: this.options.store,
      sessionId: adapter.session.id,
      checkpointId: checkpoint.id,
      createId: () => journalId,
      now: this.options.now,
      operations: this.options.operations,
    })
  }

  private appendOccurred(adapter: CheckpointServiceSession, journalId: string): boolean {
    return adapter.readEvents().some(event => {
      if (isUndoCopyAt(event, undoCopyId(journalId, 0))) return true
      return event.type === 'user/message' && isRollbackId(event.data.id)
        && event.data.id.endsWith(`:${journalId}`)
    })
  }

  private sanitize(error: unknown, signal: AbortSignal): unknown {
    if (signal.aborted) return signal.reason ?? abortError()
    if (error instanceof CheckpointRollbackError) return error
    if (error instanceof CheckpointFileError) {
      return error.code === 'FILE_CONFLICT'
        ? new CheckpointRollbackError('ROLLBACK_CONFLICT', [], error.conflicts)
        : new CheckpointRollbackError('ROLLBACK_FAILED')
    }
    return new CheckpointRollbackError('ROLLBACK_FAILED')
  }
}
