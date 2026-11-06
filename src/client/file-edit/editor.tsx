import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import styles from '../styles.module.css'
import { quoteSelectedText } from '../quote/insert.ts'
import { placeQuoteChip } from '../quote/position.ts'
import type { QuoteAnchor } from '../quote/position.ts'
import { QuotePortalLayer } from '../quote/portal-layer.tsx'
import { ensureMonaco, ensureMonacoLanguage, isDarkTheme } from './monaco-loader.ts'
import type { MonacoApi, MonacoEditor } from './monaco-loader.ts'

export interface FileMonacoEditorProps {
  readonly value: string
  readonly language: string
  readonly onChange: (value: string) => void
  readonly onSave: () => void
  readonly readOnly?: boolean
  readonly sessionId?: SessionId
  readonly quoteLabel?: string
  readonly quoteEnabled?: () => boolean
}

export interface FileMonacoEditorHandle {
  openFind(): void
}

interface LocalQuote {
  readonly text: string
  readonly anchor: QuoteAnchor
}

function LinedTextarea(props: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly sessionId?: SessionId
  readonly quoteLabel?: string
  readonly quoteEnabled?: () => boolean
}) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const [quote, setQuote] = useState<LocalQuote | null>(null)
  const lines = String(props.value || '').split('\n').length
  const nums: string[] = []
  for (let i = 1; i <= lines; i += 1) nums.push(`${i}`)

  const refreshQuote = () => {
    const area = areaRef.current
    const label = props.quoteLabel
    if (
      area === null
      || label === undefined
      || props.sessionId === undefined
      || props.quoteEnabled?.() === false
    ) {
      setQuote(null)
      return
    }
    const start = area.selectionStart
    const end = area.selectionEnd
    if (start === end) {
      setQuote(null)
      return
    }
    const text = area.value.slice(start, end).replace(/\r\n?/gu, '\n').trim()
    if (text === '') {
      setQuote(null)
      return
    }
    const rect = area.getBoundingClientRect()
    setQuote({
      text,
      anchor: placeQuoteChip({
        left: rect.left + 12,
        right: rect.left + 12,
        top: rect.top + 8,
        bottom: rect.top + 8,
      }),
    })
  }

  return (
    <div className={styles.fileEditFallback}>
      <div className={styles.fileEditGutter} aria-hidden>{nums.join('\n')}</div>
      <textarea
        ref={areaRef}
        className={styles.fileEditTextarea}
        value={props.value}
        spellCheck={false}
        onChange={event => props.onChange(event.target.value)}
        onSelect={refreshQuote}
        onKeyUp={refreshQuote}
        onMouseUp={refreshQuote}
      />
      {quote !== null && props.quoteLabel !== undefined
        ? (
          <QuotePortalLayer
            label={props.quoteLabel}
            anchor={quote.anchor}
            onQuote={() => {
              if (!quoteSelectedText(quote.text, props.sessionId)) return
              setQuote(null)
            }}
          />
        )
        : null}
    </div>
  )
}

function openEditorFind(editor: MonacoEditor | null | undefined): void {
  if (editor === null || editor === undefined) return
  try {
    editor.focus()
  } catch { /* ignore */ }
  for (const id of ['actions.find', 'editor.action.startFindReplaceAction'] as const) {
    try {
      const action = editor.getAction(id)
      if (action !== null) {
        void action.run()
        return
      }
    } catch { /* try next */ }
  }
  try {
    editor.trigger('file-edit', 'actions.find', null)
  } catch { /* ignore */ }
}

function readMonacoQuote(editor: MonacoEditor, host: HTMLElement): LocalQuote | null {
  const selection = editor.getSelection()
  const model = editor.getModel()
  if (selection === null || model === null || selection.isEmpty()) return null
  const text = model.getValueInRange(selection).replace(/\r\n?/gu, '\n').trim()
  if (text === '') return null
  const visible = editor.getScrolledVisiblePosition({
    lineNumber: selection.startLineNumber,
    column: selection.startColumn,
  })
  const hostRect = host.getBoundingClientRect()
  if (visible === null) {
    return {
      text,
      anchor: placeQuoteChip({
        left: hostRect.left + 16,
        right: hostRect.left + 16,
        top: hostRect.top + 16,
        bottom: hostRect.top + 16,
      }),
    }
  }
  const left = hostRect.left + visible.left
  const top = hostRect.top + visible.top
  return {
    text,
    anchor: placeQuoteChip({
      left,
      right: left + 1,
      top,
      bottom: top + Math.max(visible.height, 16),
    }),
  }
}

export const FileMonacoEditor = forwardRef<FileMonacoEditorHandle, FileMonacoEditorProps>(
  function FileMonacoEditor(props, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null)
    const editorRef = useRef<MonacoEditor | null>(null)
    const monacoRef = useRef<MonacoApi | null>(null)
    const changeRef = useRef(props.onChange)
    const saveRef = useRef(props.onSave)
    changeRef.current = props.onChange
    saveRef.current = props.onSave
    const [failed, setFailed] = useState(false)
    const [ready, setReady] = useState(false)
    const [quote, setQuote] = useState<LocalQuote | null>(null)
    const applyingExternal = useRef(false)

    useImperativeHandle(ref, () => ({
      openFind() {
        openEditorFind(editorRef.current)
        try {
          editorRef.current?.focus()
        } catch { /* ignore */ }
      },
    }), [])

    useEffect(() => {
      let disposed = false
      let editor: MonacoEditor | undefined
      let selectionSub: { dispose(): void } | undefined
      ensureMonaco()
        .then(async monaco => {
          monacoRef.current = monaco
          await ensureMonacoLanguage(props.language)
          if (disposed || hostRef.current === null) return
          applyingExternal.current = true
          editor = monaco.editor.create(hostRef.current, {
            value: props.value,
            language: props.language || 'plaintext',
            theme: isDarkTheme() ? 'vs-dark' : 'vs',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            renderWhitespace: 'none',
            tabSize: 2,
            readOnly: props.readOnly === true,
            matchBrackets: 'always',
            bracketPairColorization: { enabled: true },
            find: {
              addExtraSpaceOnTop: false,
              autoFindInSelection: 'never',
              seedSearchStringFromSelection: 'selection',
            },
          })
          editorRef.current = editor
          editor.onDidChangeModelContent(() => {
            if (applyingExternal.current) return
            changeRef.current(editor!.getValue())
          })
          selectionSub = editor.onDidChangeCursorSelection(() => {
            const host = hostRef.current
            if (host === null || editor === undefined || props.quoteEnabled?.() === false) {
              setQuote(null)
              return
            }
            setQuote(readMonacoQuote(editor, host))
          })
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            saveRef.current()
          })
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => {
            openEditorFind(editor)
          })
          applyingExternal.current = false
          setReady(true)
        })
        .catch(() => {
          if (!disposed) setFailed(true)
        })
      return () => {
        disposed = true
        try {
          selectionSub?.dispose()
        } catch { /* ignore */ }
        try {
          editor?.dispose()
        } catch { /* ignore */ }
        editorRef.current = null
        monacoRef.current = null
      }
      // Mount once; language / value sync in dedicated effects.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
      const editor = editorRef.current
      const monaco = monacoRef.current
      if (!editor || !monaco || !ready) return
      let cancelled = false
      void ensureMonacoLanguage(props.language).then(() => {
        if (cancelled) return
        try {
          const model = editor.getModel()
          if (model === null) return
          if (model.getLanguageId() === props.language) return
          monaco.editor.setModelLanguage(model, props.language || 'plaintext')
        } catch { /* ignore */ }
      })
      return () => {
        cancelled = true
      }
    }, [props.language, ready])

    useEffect(() => {
      const editor = editorRef.current
      if (!editor || !ready) return
      try {
        if (editor.getValue() === props.value) return
        applyingExternal.current = true
        editor.setValue(props.value)
        applyingExternal.current = false
      } catch {
        applyingExternal.current = false
      }
    }, [props.value, ready])

    useEffect(() => {
      const editor = editorRef.current
      if (!editor || !ready) return
      try {
        editor.updateOptions({ readOnly: props.readOnly === true })
      } catch { /* ignore */ }
    }, [props.readOnly, ready])

    if (failed) {
      return (
        <LinedTextarea
          value={props.value}
          onChange={props.onChange}
          sessionId={props.sessionId}
          quoteLabel={props.quoteLabel}
          quoteEnabled={props.quoteEnabled}
        />
      )
    }
    const showQuote = quote !== null
      && props.quoteLabel !== undefined
      && props.quoteEnabled?.() !== false
    return (
      <>
        <div
          ref={hostRef}
          className={styles.fileEditMonacoHost}
          data-agent-enhancer-monaco=""
        />
        {showQuote
          ? (
            <QuotePortalLayer
              label={props.quoteLabel!}
              anchor={quote!.anchor}
              onQuote={() => {
                if (!quoteSelectedText(quote!.text, props.sessionId)) return
                setQuote(null)
              }}
            />
          )
          : null}
      </>
    )
  },
)
