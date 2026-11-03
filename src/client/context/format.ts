export function formatTokens(value: number): string {
  if (value < 1e3) return String(value)
  if (value < 1e6) {
    const scaled = value / 1e3
    return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}K`
  }
  const scaled = value / 1e6
  return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}M`
}

export function sharePercent(tokens: number, total: number): number {
  if (total <= 0 || tokens <= 0) return 0
  return Math.max(1, Math.round((tokens / total) * 100))
}
