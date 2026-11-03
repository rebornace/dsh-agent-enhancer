// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextInspectRightTab } from '../src/client/context/right-tab.tsx'
import type { ContextInspectResult } from '../src/host/context-inspect.ts'

afterEach(() => {
  cleanup()
})

describe('ContextInspectRightTab', () => {
  it('sorts by tokens, expands detail inline, and shows headroom', async () => {
    const result: ContextInspectResult = {
      sessionId: 's1' as never,
      category: 'messages',
      totalTokens: 100,
      approximate: true,
      pressure: { projectedTokens: 1200, contextWindow: 128_000 },
      events: [{ id: 'e1', kind: 'compact', seq: 9, shadowed: 4, title: 'compact · seq 9' }],
      items: [
        {
          id: 'a',
          title: 'Small',
          detail: 'short',
          body: 'small body',
          tokens: 20,
          kind: 'user',
          replaced: false,
        },
        {
          id: 'b',
          title: 'Large',
          detail: 'long preview',
          body: 'large body text',
          tokens: 80,
          kind: 'assistant',
          replaced: true,
        },
      ],
    }
    const inspect = vi.fn(async (_sessionId: string, category: string) => {
      if (category === 'messages') return result
      return {
        sessionId: 's1' as never,
        category,
        totalTokens: category === 'tools' ? 40 : 10,
        approximate: true as const,
        pressure: result.pressure,
        events: result.events,
        items: [],
      }
    })
    const compact = vi.fn(async () => ({
      sessionId: 's1' as never,
      status: 'compacted' as const,
      shadowedCount: 4,
      shadowedTokens: 900,
    }))
    const props = {
      useTabInfo: () => ({
        sidebar: { expanded: true, fullscreen: false },
        panel: { id: 'pane-1' },
        tab: {
          navigation: {
            address: 'x',
            params: { sessionId: 's1', category: 'messages' as const },
            revision: 1,
          },
          visible: true,
          signal: new AbortController().signal,
          actions: {
            bindCommands: () => () => {},
            openResource: () => {},
            openTab: () => {},
            close: () => {},
          },
        },
      }),
      inspect,
      compact,
      t: (key: string, values?: Record<string, string | number>) => {
        if (key === 'contextInspectApproxTotal') return `~${values?.tokens}`
        if (key === 'contextInspectCompactDone') return `done ${values?.count}/${values?.tokens}`
        if (key.startsWith('contextInspectCategory_')) return key.slice('contextInspectCategory_'.length)
        if (key.startsWith('contextInspectKind_')) return key.slice('contextInspectKind_'.length)
        if (key.startsWith('contextInspectEvent_')) return key.slice('contextInspectEvent_'.length)
        return key
      },
    }
    render(createElement(ContextInspectRightTab, props as never))

    await waitFor(() => expect(inspect).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByLabelText('contextInspectChartMessages')).toBeTruthy())
    expect(screen.getByLabelText('contextInspectHeadroom').textContent).toContain('1.2K')
    expect(screen.getByLabelText('contextInspectEvents').textContent).toContain('compact')

    // Share is of whole context (10+40+100), not of the messages category alone.
    expect(screen.getByText('Large').closest('button')?.textContent).toContain('53%')
    expect(screen.getByText('Large').closest('button')?.textContent).toContain('contextInspectReplaced')

    fireEvent.click(screen.getByText('Large'))
    expect(screen.getByLabelText('contextInspectItemDetail').textContent).toContain('large body text')
    expect(screen.queryByRole('option')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /contextInspectCompact/ }))
    await waitFor(() => expect(compact).toHaveBeenCalledWith('s1', expect.any(AbortSignal)))
    await waitFor(() => expect(screen.getByText('done 4/900')).toBeTruthy())

    fireEvent.click(screen.getByRole('tab', { name: /tools/i }))
    await waitFor(() => expect(inspect).toHaveBeenCalledWith('s1', 'tools', expect.any(AbortSignal)))
  })

  it('localizes chart legend labels from t at render time', async () => {
    const result: ContextInspectResult = {
      sessionId: 's1' as never,
      category: 'messages',
      totalTokens: 30,
      approximate: true,
      pressure: {},
      events: [],
      items: [
        {
          id: 'u',
          title: 'User',
          detail: 'hi',
          body: 'hi',
          tokens: 10,
          kind: 'user',
          replaced: false,
        },
        {
          id: 'a',
          title: 'Assistant',
          detail: 'yo',
          body: 'yo',
          tokens: 20,
          kind: 'assistant',
          replaced: false,
        },
      ],
    }
    const inspect = vi.fn(async (_sessionId: string, category: string) => {
      if (category === 'messages') return result
      return {
        sessionId: 's1' as never,
        category,
        totalTokens: 0,
        approximate: true as const,
        pressure: {},
        events: [],
        items: [],
      }
    })
    const compact = vi.fn(async () => ({
      sessionId: 's1' as never,
      status: 'noop' as const,
      shadowedCount: 0,
      shadowedTokens: 0,
    }))
    const baseProps = {
      useTabInfo: () => ({
        sidebar: { expanded: true, fullscreen: false },
        panel: { id: 'pane-1' },
        tab: {
          navigation: {
            address: 'x',
            params: { sessionId: 's1', category: 'messages' as const },
            revision: 1,
          },
          visible: true,
          signal: new AbortController().signal,
          actions: {
            bindCommands: () => () => {},
            openResource: () => {},
            openTab: () => {},
            close: () => {},
          },
        },
      }),
      inspect,
      compact,
    }
    const en = (key: string) => {
      if (key === 'contextInspectKind_user') return 'User'
      if (key === 'contextInspectKind_assistant') return 'Assistant'
      if (key === 'contextInspectChartMessages') return 'Message composition (~)'
      if (key === 'contextInspectCompact') return 'Compact context'
      if (key === 'contextInspectCompacting') return 'Compacting…'
      if (key === 'contextInspectCompactHint') return 'hint'
      return key
    }
    const { rerender } = render(createElement(ContextInspectRightTab, { ...baseProps, t: en } as never))
    await waitFor(() => expect(screen.getByLabelText('Message composition (~)')).toBeTruthy())
    expect(screen.getByLabelText('Message composition (~)').textContent).toContain('User')
    expect(screen.getByLabelText('Message composition (~)').textContent).toContain('Assistant')
    expect(screen.getByRole('button', { name: 'Compact context' }).textContent).toContain('Compact context')

    const zh = (key: string) => {
      if (key === 'contextInspectKind_user') return '用户'
      if (key === 'contextInspectKind_assistant') return '助手'
      if (key === 'contextInspectChartMessages') return '消息构成（约）'
      if (key === 'contextInspectCompact') return '压缩上下文'
      if (key === 'contextInspectCompacting') return '正在压缩…'
      if (key === 'contextInspectCompactHint') return '提示'
      return key
    }
    rerender(createElement(ContextInspectRightTab, { ...baseProps, t: zh } as never))
    await waitFor(() => expect(screen.getByLabelText('消息构成（约）')).toBeTruthy())
    expect(screen.getByLabelText('消息构成（约）').textContent).toContain('用户')
    expect(screen.getByLabelText('消息构成（约）').textContent).toContain('助手')
  })
})
