export function formatTokenCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

/** Format a CNY estimate with up to 4 decimals, trimming trailing zeros. */
export function formatCnyAmount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  const fixed = value.toFixed(4)
  return fixed.replace(/\.?0+$/, '') || '0'
}

export function formatUsageWhen(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at)
}
