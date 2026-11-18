import { describe, expect, it } from 'vitest'
import { splitSkillFrontmatter } from '../src/client/instructions-skills/markdown-preview.tsx'

describe('splitSkillFrontmatter', () => {
  it('splits YAML frontmatter from the markdown body', () => {
    const split = splitSkillFrontmatter('---\nname: demo\ndescription: x\n---\n\n# Title\n')
    expect(split).toEqual({
      source: 'name: demo\ndescription: x',
      body: '\n# Title\n',
    })
  })

  it('returns undefined when there is no frontmatter', () => {
    expect(splitSkillFrontmatter('# Title\n')).toBeUndefined()
  })
})
