/** Installed-list scope buckets derived from filesystem / registry providers. */
export type SkillScopeBucket = 'user' | 'project' | 'other'

export function skillScopeBucket(provider: string): SkillScopeBucket {
  switch (provider) {
    case 'shared':
    case 'dsh-home':
      return 'user'
    case 'project':
    case 'project-dsh':
      return 'project'
    default:
      return 'other'
  }
}
