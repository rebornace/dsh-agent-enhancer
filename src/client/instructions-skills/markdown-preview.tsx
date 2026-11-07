/**
 * In-panel SKILL.md preview — peers official document-markdown
 * (`dsh-client-ui-sidebar-documentpreview` MarkdownBody → primitives MarkdownText).
 */
import { useMemo } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import styles from '../styles.module.css'

/** Leading YAML frontmatter split (same regex as official MarkdownBody). */
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u

export function splitSkillFrontmatter(text: string): {
  readonly source: string
  readonly body: string
} | undefined {
  const match = FRONTMATTER.exec(text)
  if (match === null) return undefined
  return {
    source: match[1] ?? '',
    body: text.slice(match[0].length),
  }
}

export function SkillMarkdownPreview(props: {
  readonly text: string
  readonly t: TranslateNS<'agent-enhancer'>
}) {
  const split = useMemo(() => splitSkillFrontmatter(props.text), [props.text])
  const labels = useMemo((): MarkdownLabels => ({
    code: {
      copyLabel: props.t('instructionsSkillsMdCopy'),
      copiedLabel: props.t('instructionsSkillsMdCopied'),
      toolbarLabels: {
        codeLabel: props.t('instructionsSkillsMdCode'),
        wrapLabel: props.t('instructionsSkillsMdWrap'),
        unwrapLabel: props.t('instructionsSkillsMdUnwrap'),
      },
    },
    footnotes: props.t('instructionsSkillsMdFootnotes'),
  }), [props.t])

  return (
    <div className={styles.instructionsSkillsPreviewBody} data-document-markdown>
      {split === undefined ? null : (
        <div className={styles.instructionsSkillsFrontmatter} data-document-frontmatter>
          <pre className={styles.instructionsSkillsFrontmatterSource}>{split.source}</pre>
        </div>
      )}
      <MarkdownText
        text={split?.body ?? props.text}
        streaming={false}
        labels={labels}
        variant="body"
      />
    </div>
  )
}
