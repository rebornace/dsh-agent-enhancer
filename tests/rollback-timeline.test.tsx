// @vitest-environment jsdom
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentLocales } from '../src/client/locales.ts'
import type { RollbackRemote } from '../src/client/rollback/types.ts'
import { CheckpointTimelinePanel } from '../src/client/rollback/timeline-panel.tsx'
import {
  formatCheckpointTime,
  sortTimelineByConversation,
  timelineCoverageLabel,
  timelineGapLabel,
  timelinePromptLabel,
} from '../src/client/rollback/timeline-format.ts'
import {
  activeRollbackWindow,
  checkpointPromptPreview,
  isRolledBackCheckpoint,
  toCheckpointTurnSummary,
} from '../src/host/checkpoint/service.ts'
import type { Checkpoint } from '../src/host/checkpoint/types.ts'
import { ROLLBACK_PREFIX } from '../src/identity.ts'

const sessionId = 'session-1' as SessionId

function translate(key: string, params?: Record<string, unknown>): string {
  const table = agentLocales.en as unknown as Record<string, string>
  let text = table[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}

afterEach(() => {
  cleanup()
})

describe('checkpoint timeline helpers', () => {
  it('truncates prompt previews and strips file bodies from summaries', () => {
    expect(checkpointPromptPreview('  hello\n\nworld  ')).toBe('hello world')
    expect(checkpointPromptPreview('x'.repeat(120)).endsWith('…')).toBe(true)

    const checkpoint: Checkpoint = {
      schemaVersion: 1,
      pluginVersion: '0.3.0',
      id: 'c1',
      sessionId,
      session: { format: 4, preset: null },
      turn: 2,
      atSeq: 5,
      prompt: 'restore me',
      createdAt: 1_700_000_000_000,
      stage: 'committed',
      coverage: 'complete',
      gaps: [],
      files: [{
        path: 'a.ts',
        change: 'modify',
        beforeText: 'secret-before',
        beforeHash: 'b',
        afterText: 'secret-after',
        afterHash: 'a',
      }],
    }
    expect(toCheckpointTurnSummary(checkpoint)).toEqual({
      turn: 2,
      coverage: 'complete',
      fileCount: 1,
      createdAt: 1_700_000_000_000,
      atSeq: 5,
      prompt: 'restore me',
      promptPreview: 'restore me',
      files: [{ path: 'a.ts', change: 'modify' }],
      gaps: [],
      rolledBack: false,
      tip: false,
    })
    expect(toCheckpointTurnSummary(checkpoint, { rolledBack: true }).rolledBack).toBe(true)
    expect(toCheckpointTurnSummary(checkpoint, { rolledBack: true, tip: true }).tip).toBe(true)
    expect(toCheckpointTurnSummary({
      ...checkpoint,
      prompt: '',
      coverage: 'partial',
      gaps: [{ type: 'prompt', reason: 'non-text-content' }],
      files: [],
    }, { recoveredPrompt: 'recovered from events' })).toMatchObject({
      prompt: 'recovered from events',
      promptPreview: 'recovered from events',
      coverage: 'complete',
      gaps: [],
    })
    expect(JSON.stringify(toCheckpointTurnSummary(checkpoint))).not.toContain('secret-')
  })

  it('orders by conversation position (atSeq) so list order matches chat', () => {
    const turns = sortTimelineByConversation([
      {
        turn: 3, coverage: 'partial', fileCount: 2, createdAt: 3,
        atSeq: 8, prompt: 'x', promptPreview: 'x', files: [],
        gaps: [{ type: 'workspace', reason: 'capture-failed' }], rolledBack: false, tip: false,
      },
      {
        turn: 1, coverage: 'complete', fileCount: 0, createdAt: 1,
        atSeq: 0, prompt: '', promptPreview: '', files: [], gaps: [], rolledBack: false, tip: false,
      },
      {
        // Higher turn id but earlier log position must not sort after a later cut.
        turn: 9, coverage: 'complete', fileCount: 0, createdAt: 9,
        atSeq: 4, prompt: 'mid', promptPreview: 'mid', files: [], gaps: [], rolledBack: false, tip: false,
      },
    ])
    expect(turns.map(turn => turn.turn)).toEqual([1, 9, 3])
    expect(timelineCoverageLabel(turns[2]!, translate)).toContain('Partial')
    expect(timelineGapLabel(turns[2]!.gaps[0]!, translate)).toContain('Workspace capture')
    expect(formatCheckpointTime(1_700_000_000_000, 'en')).toMatch(/\d/)
  })

  it('labels empty prompts with a file fallback and marks active rolled-back turns', () => {
    expect(timelinePromptLabel({
      turn: 1, coverage: 'complete', fileCount: 1, createdAt: 1, atSeq: 0,
      prompt: '', promptPreview: '', files: [{ path: 'blank.txt', change: 'create' }],
      gaps: [], rolledBack: false, tip: false,
    }, translate)).toEqual({ text: 'blank.txt', empty: false })
    expect(timelinePromptLabel({
      turn: 1, coverage: 'complete', fileCount: 0, createdAt: 1, atSeq: 0,
      prompt: '', promptPreview: '', files: [], gaps: [], rolledBack: false, tip: false,
    }, translate).empty).toBe(true)

    const events = [
      {
        seq: 20, time: 1, type: 'user/message', surfaceOp: 'append',
        data: {
          id: `${ROLLBACK_PREFIX}3:j1`,
          role: 'user',
          content: [{ type: 'text', text: 'Rolled back' }],
          source: { kind: 'checkpoint-rollback', form: 'notice', summary: 'Rolled back' },
        },
      },
    ] as unknown as SessionEvent[]
    const window = activeRollbackWindow(events)
    expect(window).toEqual({ tipTurn: 3, hideTurnsFrom: 3, continueAfterSeq: 20 })
    expect(isRolledBackCheckpoint(3, 9, window)).toBe(true)
    expect(isRolledBackCheckpoint(2, 4, window)).toBe(false)
    expect(isRolledBackCheckpoint(3, 20, window)).toBe(false)
  })
})

describe('CheckpointTimelinePanel', () => {
  it('lists checkpoints, expands detail, and restores a turn', async () => {
    const onRestore = vi.fn()
    const onUndo = vi.fn()
    const remote: RollbackRemote = {
      preview: vi.fn(),
      execute: vi.fn(),
      summaries: vi.fn(async () => ({
        sessionId,
        activity: { turns: 2, steps: 2, checkpoints: 3, liveCheckpoints: 2 },
        turns: [
          {
            turn: 3,
            coverage: 'partial' as const,
            fileCount: 1,
            createdAt: Date.now(),
            atSeq: 9,
            prompt: 'shell create',
            promptPreview: 'shell create',
            files: [{ path: 'blank.txt', change: 'create' as const }],
            gaps: [{ type: 'workspace' as const, reason: 'capture-failed' as const }],
            rolledBack: true,
            tip: true,
          },
          {
            turn: 2,
            coverage: 'complete' as const,
            fileCount: 1,
            createdAt: Date.now() - 1000,
            atSeq: 5,
            prompt: 'second prompt',
            promptPreview: 'second prompt',
            files: [{ path: 'src/app.ts', change: 'modify' as const }],
            gaps: [],
            rolledBack: false,
            tip: false,
          },
          {
            turn: 1,
            coverage: 'complete' as const,
            fileCount: 0,
            createdAt: Date.now() - 2000,
            atSeq: 1,
            prompt: 'hello',
            promptPreview: 'hello',
            files: [],
            gaps: [],
            rolledBack: false,
            tip: false,
          },
        ],
      })),
    }
    const { container } = render(<CheckpointTimelinePanel
      sessionId={sessionId}
      remote={remote}
      t={translate}
      locale="en"
      onRestore={onRestore}
      onUndo={onUndo}
    />)

    await screen.findByRole('button', { name: /Turn 2/i })
    expect(container.querySelector('[data-coverage="partial"]')).toBeTruthy()
    expect(container.querySelector('[data-coverage="files"]')).toBeTruthy()
    expect(container.querySelector('[data-coverage="conversation"]')).toBeTruthy()
    expect(container.querySelector('[data-rolled-back]')).toBeTruthy()
    expect(container.querySelector('[data-tip]')).toBeTruthy()
    expect(screen.getByText('Current restore point')).toBeTruthy()
    expect(screen.getAllByText('second prompt').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /Turn 2/i }))
    expect(screen.getAllByText('second prompt').length).toBeGreaterThan(0)
    expect(screen.getByText('src/app.ts')).toBeTruthy()
    expect(container.querySelector('[data-change="modify"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restore to here' }))
    expect(onRestore).toHaveBeenCalledWith(2)

    // Live tip card: only Undo restore — never both actions together.
    fireEvent.click(screen.getByRole('button', { name: /Turn 3/i }))
    expect(screen.getByRole('button', { name: 'Undo restore' })).toBeTruthy()
    expect(screen.queryAllByRole('button', { name: 'Restore to here' })).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Undo restore' }))
    expect(onUndo).toHaveBeenCalledWith(3)
  })

  it('maps tip and covered cards to undo, live cards to restore', async () => {
    const { checkpointPrimaryAction } = await import('../src/client/rollback/format.ts')
    expect(checkpointPrimaryAction({ tip: true, rolledBack: false })).toBe('undo')
    // Later rolled-back cards restore-forward — they must not full-undo the tip.
    expect(checkpointPrimaryAction({ tip: false, rolledBack: true })).toBe('restore')
    expect(checkpointPrimaryAction({ tip: false, rolledBack: false })).toBe('restore')
    expect(checkpointPrimaryAction(undefined)).toBe('restore')
  })

  it('shows empty and error states', async () => {
    const empty: RollbackRemote = {
      preview: vi.fn(),
      execute: vi.fn(),
      summaries: vi.fn(async () => ({
        sessionId,
        activity: { turns: 0, steps: 0, checkpoints: 0, liveCheckpoints: 0 },
        turns: [],
      })),
    }
    const emptyView = render(<CheckpointTimelinePanel
      sessionId={sessionId}
      remote={empty}
      t={translate}
      onRestore={vi.fn()}
      onUndo={vi.fn()}
    />)
    await waitFor(() => {
      expect(screen.getByText(/No checkpoints for this session/i)).toBeTruthy()
    })
    emptyView.unmount()

    const failing: RollbackRemote = {
      preview: vi.fn(),
      execute: vi.fn(),
      summaries: vi.fn(async () => { throw new Error('boom') }),
    }
    render(<CheckpointTimelinePanel
      sessionId={sessionId}
      remote={failing}
      t={translate}
      onRestore={vi.fn()}
      onUndo={vi.fn()}
    />)
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Could not load checkpoints')
    })
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
  })
})
