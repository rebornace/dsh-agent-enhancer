/** Lightweight shared flag: any GitHub skill has `updateAvailable` in the latest list snapshot. */

let hasUpdates = false
const listeners = new Set<() => void>()

export function getSkillsNavHasUpdates(): boolean {
  return hasUpdates
}

export function setSkillsNavHasUpdates(value: boolean): void {
  if (hasUpdates === value) return
  hasUpdates = value
  for (const listener of listeners) listener()
}

export function subscribeSkillsNavHasUpdates(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetSkillsNavHasUpdates(): void {
  setSkillsNavHasUpdates(false)
}
