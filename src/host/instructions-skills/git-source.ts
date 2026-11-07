/** Parsed git / GitHub skill install source. */
export interface ParsedGitSkillSource {
  /** Clone URL suitable for `git clone`. */
  readonly cloneUrl: string
  /** Optional path inside the repo pointing at a skill bundle or skills parent. */
  readonly subpath: string | null
  /** Display label for errors / UI. */
  readonly label: string
  /**
   * When set, prefer GitHub archive download over `git clone`
   * (more reliable on flaky HTTPS / reset connections).
   */
  readonly github: { readonly owner: string, readonly repo: string } | null
}

function githubParts(owner: string, repo: string, sub: string | null): ParsedGitSkillSource {
  const cleanRepo = repo.replace(/\.git$/i, '')
  return {
    cloneUrl: `https://github.com/${owner}/${cleanRepo}.git`,
    subpath: sub === '' ? null : sub,
    label: sub === null || sub === '' ? `${owner}/${cleanRepo}` : `${owner}/${cleanRepo}/${sub}`,
    github: { owner, repo: cleanRepo },
  }
}

/**
 * Accept `owner/repo`, `owner/repo/path/to/skill`, GitHub HTTPS/SSH URLs, or other git URLs.
 */
export function parseGitSkillSource(raw: string): ParsedGitSkillSource {
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new Error('Git skill source is empty')
  }

  // owner/repo[/sub/path]
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+))?$/.exec(trimmed)
  if (shorthand !== null && !trimmed.includes('://') && !trimmed.startsWith('git@')) {
    const sub = shorthand[3]?.replace(/^\/+|\/+$/g, '') || null
    return githubParts(shorthand[1]!, shorthand[2]!, sub)
  }

  // git@github.com:owner/repo.git[/path]
  if (trimmed.startsWith('git@')) {
    const withoutQuery = trimmed.split(/[?#]/, 1)[0]!
    const match = /^git@([^:]+):(.+?)(?:\.git)?(?:\/(.+))?$/.exec(withoutQuery)
    if (match === null) {
      return {
        cloneUrl: withoutQuery.endsWith('.git') ? withoutQuery : `${withoutQuery}.git`,
        subpath: null,
        label: withoutQuery,
        github: null,
      }
    }
    const host = match[1]!.toLowerCase()
    const repoPath = match[2]!.replace(/\.git$/i, '')
    const sub = match[3]?.replace(/^\/+|\/+$/g, '') || null
    if (host === 'github.com' || host === 'www.github.com') {
      const [owner, repo, ...rest] = repoPath.split('/')
      if (owner && repo) {
        const nested = rest.length > 0
          ? [...rest, ...(sub === null ? [] : sub.split('/'))].join('/')
          : sub
        return githubParts(owner, repo, nested === '' ? null : nested)
      }
    }
    return {
      cloneUrl: `git@${match[1]!}:${repoPath}.git`,
      subpath: sub === '' ? null : sub,
      label: sub === null ? `${host}:${repoPath}` : `${host}:${repoPath}/${sub}`,
      github: null,
    }
  }

  // https://github.com/owner/repo[/tree/branch/path|/blob/branch/path|/path]
  try {
    const url = new URL(trimmed)
    const host = url.hostname.toLowerCase()
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
    if ((host === 'github.com' || host === 'www.github.com') && parts.length >= 2) {
      const owner = parts[0]!
      const repo = parts[1]!.replace(/\.git$/i, '')
      let sub: string | null = null
      if (parts.length > 2) {
        if (parts[2] === 'tree' || parts[2] === 'blob') {
          sub = parts.length > 4 ? parts.slice(4).join('/') : null
        } else {
          sub = parts.slice(2).join('/')
        }
      }
      return githubParts(owner, repo, sub === '' ? null : sub)
    }
    const cloneUrl = trimmed.endsWith('.git')
      ? trimmed.split(/[?#]/, 1)[0]!
      : `${trimmed.split(/[?#]/, 1)[0]}.git`
    return { cloneUrl, subpath: null, label: trimmed, github: null }
  } catch {
    throw new Error(`Unrecognized git skill source: ${trimmed}`)
  }
}
