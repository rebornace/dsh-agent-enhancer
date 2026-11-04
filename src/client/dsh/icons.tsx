export function OptimizeIcon() {
  return <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8 2.5 9.8 6.2 13.5 8 9.8 9.8 8 13.5 6.2 9.8 2.5 8 6.2 6.2 8 2.5Z" />
  </svg>
}

export function UndoIcon() {
  return <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 3 2 7l4 4" />
    <path d="M2 7h7a4 4 0 0 1 0 8H7" />
  </svg>
}

/** Vertical checkpoint rail for the timeline affordance. */
export function TimelineIcon() {
  return <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 2.5v11" />
    <circle cx="4" cy="4" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="4" cy="8" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <path d="M7 4h5M7 8h5M7 12h3.5" />
  </svg>
}
