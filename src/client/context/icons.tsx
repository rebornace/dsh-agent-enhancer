import type { ContextInspectCategory } from '../../host/context-inspect.ts'

const size = 14

/** Squeeze / compact glyph for the official compact action. */
export function CompactIcon(props: { readonly size?: number }) {
  const px = props.size ?? 16
  return (
    <svg width={px} height={px} viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M2 3.2A1.2 1.2 0 0 1 3.2 2h9.6A1.2 1.2 0 0 1 14 3.2v1.1a.7.7 0 0 1-1.4 0V3.4H3.4v.9a.7.7 0 1 1-1.4 0V3.2Zm0 8.5v1.1A1.2 1.2 0 0 0 3.2 14h9.6a1.2 1.2 0 0 0 1.2-1.2v-1.1a.7.7 0 0 0-1.4 0v.9H3.4v-.9a.7.7 0 0 0-1.4 0Z"
      />
      <path
        fill="currentColor"
        d="M5.05 5.2a.7.7 0 0 1 .99.05L8 7.36l1.96-2.11a.7.7 0 1 1 1.04.94L8.7 8.6a1 1 0 0 1-1.4 0L4.99 6.19a.7.7 0 0 1 .06-.99Zm0 5.6a.7.7 0 0 0 .99-.05L8 8.64l1.96 2.11a.7.7 0 1 0 1.04-.94L8.7 7.4a1 1 0 0 0-1.4 0L4.99 9.81a.7.7 0 0 0 .06.99Z"
      />
    </svg>
  )
}

/** Compact category glyphs for the rightbar segments (Cursor-style). */
export function CategoryIcon(props: { readonly category: ContextInspectCategory }) {
  switch (props.category) {
    case 'system':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 1.5A2.5 2.5 0 0 0 5.5 4v.3A2.5 2.5 0 0 0 4 6.7V12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V6.7a2.5 2.5 0 0 0-1.5-2.4V4A2.5 2.5 0 0 0 8 1.5Zm0 1a1.5 1.5 0 0 1 1.5 1.5v.16A3.5 3.5 0 0 0 8 4a3.5 3.5 0 0 0-1.5.16V4A1.5 1.5 0 0 1 8 2.5ZM6 6.7c0-.72.58-1.3 1.3-1.3h1.4c.72 0 1.3.58 1.3 1.3V12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6.7Z"
          />
        </svg>
      )
    case 'tools':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M11.2 1.6a2.4 2.4 0 0 0-3.3 0L6.2 3.3a.7.7 0 0 0 1 1l1.7-1.7a1 1 0 0 1 1.4 1.4L5.6 8.7l-.9-.9a.7.7 0 1 0-1 1l2.4 2.4a.7.7 0 0 0 1 0l5.2-5.2a2.4 2.4 0 0 0-1.1-4.4Zm-7 8.1 1.5 1.5-2.4 1.2a.5.5 0 0 1-.6-.6l1.5-2.1Z"
          />
        </svg>
      )
    case 'messages':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M2.5 2.5h11A1.5 1.5 0 0 1 15 4v6a1.5 1.5 0 0 1-1.5 1.5H8.2L5 14.2a.6.6 0 0 1-1-.5v-2.2H2.5A1.5 1.5 0 0 1 1 10V4A1.5 1.5 0 0 1 2.5 2.5Zm0 1A.5.5 0 0 0 2 4v6a.5.5 0 0 0 .5.5H5a.5.5 0 0 1 .5.5v1.4l2-1.5a.5.5 0 0 1 .3-.1h5.7a.5.5 0 0 0 .5-.5V4a.5.5 0 0 0-.5-.5h-11Z"
          />
        </svg>
      )
    default: {
      const _exhaustive: never = props.category
      return _exhaustive
    }
  }
}
