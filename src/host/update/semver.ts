function parseSemver(version: string): [number, number, number] | null {
  const trimmed = version.startsWith('v') ? version.slice(1) : version
  const parts = trimmed.split('.')
  if (parts.length !== 3) {
    return null
  }
  const nums: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null
    }
    nums.push(Number(part))
  }
  return nums as [number, number, number]
}

export function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = parseSemver(latest)
  const currentParts = parseSemver(current)
  if (latestParts === null || currentParts === null) {
    return false
  }
  const [lMajor, lMinor, lPatch] = latestParts
  const [cMajor, cMinor, cPatch] = currentParts
  if (lMajor !== cMajor) {
    return lMajor > cMajor
  }
  if (lMinor !== cMinor) {
    return lMinor > cMinor
  }
  return lPatch > cPatch
}
