import { describe, expect, it, vi } from 'vitest'
import {
  getSkillsNavHasUpdates,
  resetSkillsNavHasUpdates,
  setSkillsNavHasUpdates,
  subscribeSkillsNavHasUpdates,
} from '../src/client/instructions-skills/nav-update-hints.ts'

describe('skills nav update hints', () => {
  it('tracks hasUpdates and notifies subscribers', () => {
    resetSkillsNavHasUpdates()
    expect(getSkillsNavHasUpdates()).toBe(false)
    const listener = vi.fn()
    const off = subscribeSkillsNavHasUpdates(listener)
    setSkillsNavHasUpdates(true)
    expect(getSkillsNavHasUpdates()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    setSkillsNavHasUpdates(true)
    expect(listener).toHaveBeenCalledTimes(1)
    setSkillsNavHasUpdates(false)
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    resetSkillsNavHasUpdates()
    expect(getSkillsNavHasUpdates()).toBe(false)
  })
})
