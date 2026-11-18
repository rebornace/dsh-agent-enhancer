// @vitest-environment jsdom
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstructionsSkillsSnapshot, SkillCatalogEntry } from '../src/host/instructions-skills/types.ts'
import {
  InstructionsSkillsMainPanel,
  matchesQuery,
  skillShowsGitUpdate,
} from '../src/client/instructions-skills/tab.tsx'
import type { InstructionsSkillsMainPanelProps } from '../src/client/instructions-skills/tab.tsx'
import { resetSkillsNavHasUpdates } from '../src/client/instructions-skills/nav-update-hints.ts'
import {
  agentEnhancerGetSkillInstallProgress,
  agentEnhancerInstallSkillFromGit,
  agentEnhancerListInstructionsSkills,
  agentEnhancerReadSkillDocument,
} from '../src/client/instructions-skills/remote.ts'

vi.mock('../src/client/instructions-skills/remote.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/client/instructions-skills/remote.ts')>()
  return {
    ...actual,
    agentEnhancerListInstructionsSkills: {
      invoke: vi.fn(),
    },
    agentEnhancerReadSkillDocument: {
      invoke: vi.fn(),
    },
    agentEnhancerInstallSkillFromGit: {
      invoke: vi.fn(),
    },
    agentEnhancerGetSkillInstallProgress: {
      invoke: vi.fn(),
    },
  }
})

const SESSION_ID = 'sess-skills' as SessionId

const translations: Record<string, string> = {
  instructionsSkillsTitle: 'Skills',
  instructionsSkillsIntro: 'Install into ~/.agents/skills, invoke with /',
  instructionsSkillsAdd: 'Add',
  instructionsSkillsRefresh: 'Refresh',
  instructionsSkillsRefreshHint: 'Rescan',
  instructionsSkillsPaneInstall: 'Install',
  instructionsSkillsPaneInstalled: 'Installed',
  instructionsSkillsMissing: 'Missing path',
  instructionsSkillsInstallGit: 'Install from GitHub',
  instructionsSkillsInstallGitHint: 'GitHub hint',
  instructionsSkillsInstallGitPlaceholder: 'owner/repo',
  instructionsSkillsInstall: 'Install',
  instructionsSkillsInstalling: 'Installing…',
  instructionsSkillsInstallCancel: 'Cancel install',
  instructionsSkillsInstallCancelled: 'Install cancelled',
  instructionsSkillsInstallStageResolving: 'Resolving source',
  instructionsSkillsInstallStageDownloading: 'Downloading repo',
  instructionsSkillsInstallStageExtracting: 'Extracting',
  instructionsSkillsInstallStageCloning: 'Cloning repo',
  instructionsSkillsInstallStageCopying: 'Copying skills',
  instructionsSkillsInstallStageFinishing: 'Refreshing list',
  instructionsSkillsInstallProgressLine: '{stage} · {seconds}s elapsed',
  instructionsSkillsInstallProgressBytes: '{received} / {total}',
  instructionsSkillsInstallProgressBytesUnknown: '{received} downloaded',
  instructionsSkillsInstallZip: 'Install from Zip',
  instructionsSkillsInstallZipHint: 'Zip hint',
  instructionsSkillsZipNoUpdateHint: 'Zip installs do not support update checks.',
  instructionsSkillsInstallHint: 'Use / after install',
  instructionsSkillsInstalledEmpty: 'No skills yet',
  instructionsSkillsInstalledNote: 'Installed',
  instructionsSkillsUninstallCancel: 'Cancel',
  instructionsSkillsUpdateAvailable: 'Update available',
  instructionsSkillsUpdate: 'Update',
  instructionsSkillsUpdating: 'Updating…',
  instructionsSkillsUpdateCheckFailed: 'Update check failed for some skills.',
  instructionsSkillsChannelGithub: 'GitHub',
  instructionsSkillsChannelZip: 'Zip',
  instructionsSkillsChannelUnknown: 'Other',
  instructionsSkillsSearch: 'Search',
  instructionsSkillsSearchPlaceholder: 'Name, description, or owner/repo…',
  instructionsSkillsFilter: 'Filter',
  instructionsSkillsFilterAll: 'All',
  instructionsSkillsFilterUser: 'User',
  instructionsSkillsFilterProject: 'Project',
  instructionsSkillsFilterOther: 'Other',
  instructionsSkillsProviderUser: 'User skills',
  instructionsSkillsProviderDsh: 'DSH',
  instructionsSkillsProviderProject: 'Project',
  instructionsSkillsProviderProjectDsh: 'Project DSH',
  instructionsSkillsProviderRegistry: 'Registry',
  instructionsSkillsUninstall: 'Uninstall',
  instructionsSkillsUninstallHint: 'Remove',
  instructionsSkillsNoSession: 'No session',
  instructionsSkillsLoading: 'Loading…',
  instructionsSkillsPreviewEmpty: 'Select a skill',
  instructionsSkillsPreviewLoading: 'Loading preview…',
  instructionsSkillsPreviewBack: 'Back',
  instructionsSkillsOpenInSidebar: 'Open in sidebar',
  instructionsSkillsOpenInSidebarHint: 'Leave Skills and open right sidebar',
  instructionsSkillsMdCopy: 'Copy',
  instructionsSkillsMdCopied: 'Copied',
  instructionsSkillsMdFootnotes: 'Footnotes',
  instructionsSkillsMdCode: 'Code',
  instructionsSkillsMdWrap: 'Wrap',
  instructionsSkillsMdUnwrap: 'Unwrap',
}

const t: TranslateNS<'agent-enhancer'> = (key) => translations[key] ?? key

function skillRow(
  partial: Partial<SkillCatalogEntry> & Pick<SkillCatalogEntry, 'id' | 'name'>,
): SkillCatalogEntry {
  return {
    description: '',
    path: '/home/.agents/skills/test',
    provider: 'shared',
    modelInvocable: null,
    userInvocable: null,
    removable: true,
    installChannel: null,
    updateAvailable: false,
    updateSourceLabel: null,
    updateCheckFailed: false,
    ...partial,
  }
}

function snapshot(skills: SkillCatalogEntry[]): InstructionsSkillsSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: '/workspace',
    projectRoot: '/workspace',
    instructions: [],
    skills,
    skillsSource: 'merged',
  }
}

function panelProps(
  overrides: Partial<InstructionsSkillsMainPanelProps> = {},
): InstructionsSkillsMainPanelProps {
  return {
    remote: () => ({ agentEnhancer: {} }),
    sidebarRight: undefined,
    t,
    sessionId: SESSION_ID,
    ...overrides,
  } as InstructionsSkillsMainPanelProps
}

async function renderLoaded(skills: SkillCatalogEntry[]) {
  vi.mocked(agentEnhancerListInstructionsSkills.invoke).mockResolvedValue(snapshot(skills))
  render(<InstructionsSkillsMainPanel {...panelProps()} />)
  await waitFor(() => {
    expect(agentEnhancerListInstructionsSkills.invoke).toHaveBeenCalled()
  })
}

async function openAddSheet() {
  const adds = await screen.findAllByRole('button', { name: translations.instructionsSkillsAdd })
  fireEvent.click(adds[0]!)
}

async function waitForInstalledList() {
  await waitFor(() => {
    expect(agentEnhancerListInstructionsSkills.invoke).toHaveBeenCalled()
  })
}

afterEach(() => {
  cleanup()
  resetSkillsNavHasUpdates()
  vi.clearAllMocks()
})

describe('skillShowsGitUpdate', () => {
  it('is true only for github channel with updateAvailable', () => {
    expect(skillShowsGitUpdate(skillRow({
      id: 'a',
      name: 'a',
      installChannel: 'github',
      updateAvailable: true,
    }))).toBe(true)
    expect(skillShowsGitUpdate(skillRow({
      id: 'b',
      name: 'b',
      installChannel: 'zip',
      updateAvailable: true,
    }))).toBe(false)
  })
})

describe('matchesQuery owner/repo', () => {
  it('matches GitHub install source shorthand and URLs', () => {
    const entry = skillRow({
      id: 'brain',
      name: 'brainstorming',
      description: 'plan first',
      installChannel: 'github',
      updateSourceLabel: 'jnMetaCode/superpowers-zh',
    })
    expect(matchesQuery(entry, 'jnMetaCode/superpowers-zh')).toBe(true)
    expect(matchesQuery(entry, 'superpowers-zh')).toBe(true)
    expect(matchesQuery(entry, 'https://github.com/jnMetaCode/superpowers-zh')).toBe(true)
    expect(matchesQuery(entry, 'obra/superpowers')).toBe(false)
    expect(matchesQuery(entry, 'brainstorming')).toBe(true)
  })
})

describe('InstructionsSkillsPanel update UI', () => {
  beforeEach(() => {
    resetSkillsNavHasUpdates()
  })

  it('opens the Add sheet with GitHub and Zip install actions', async () => {
    await renderLoaded([])
    await openAddSheet()
    expect(await screen.findByText(translations.instructionsSkillsInstallGit!)).toBeTruthy()
    expect(screen.getByRole('button', { name: translations.instructionsSkillsInstallZip })).toBeTruthy()
  })

  it('shows GitHub install stage progress and cancel while install is in flight', async () => {
    let resolveInstall: ((value: {
      installed: []
      skippedBusy: []
      snapshot: InstructionsSkillsSnapshot
    }) => void) | undefined
    vi.mocked(agentEnhancerInstallSkillFromGit.invoke).mockImplementation(
      () => new Promise(resolve => {
        resolveInstall = resolve
      }),
    )
    vi.mocked(agentEnhancerGetSkillInstallProgress.invoke).mockResolvedValue({
      sessionId: SESSION_ID,
      stage: 'downloading',
      detail: 'owner/repo',
      bytesReceived: 2048,
      bytesTotal: 8192,
      startedAt: Date.now() - 2500,
    })

    await renderLoaded([])
    await openAddSheet()
    fireEvent.change(screen.getByPlaceholderText(translations.instructionsSkillsInstallGitPlaceholder!), {
      target: { value: 'owner/repo' },
    })
    fireEvent.click(screen.getByRole('button', { name: translations.instructionsSkillsInstall }))

    expect(await screen.findByRole('button', { name: translations.instructionsSkillsInstallCancel })).toBeTruthy()
    await waitFor(() => {
      expect(agentEnhancerGetSkillInstallProgress.invoke).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/Downloading repo/)
    })

    resolveInstall?.({ installed: [], skippedBusy: [], snapshot: snapshot([]) })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: translations.instructionsSkillsInstallCancel })).toBeNull()
    })
  })

  it('shows update badge and button for github skills with updateAvailable', async () => {
    await renderLoaded([
      skillRow({
        id: 'gh1',
        name: 'papercheck',
        installChannel: 'github',
        updateAvailable: true,
        updateSourceLabel: 'owner/repo',
      }),
    ])
    await waitForInstalledList()
    expect(await screen.findByText('Update available')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy()
  })

  it('does not show update controls for zip even when updateAvailable is true', async () => {
    await renderLoaded([
      skillRow({
        id: 'zip1',
        name: 'zip-skill',
        installChannel: 'zip',
        updateAvailable: true,
      }),
    ])
    await waitFor(() => {
      expect(screen.getByText('zip-skill')).toBeTruthy()
    })
    expect(screen.queryByText('Update available')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  })

  it('shows the update check failed bar when any skill has updateCheckFailed', async () => {
    await renderLoaded([
      skillRow({
        id: 'gh-fail',
        name: 'stale-check',
        installChannel: 'github',
        updateCheckFailed: true,
      }),
    ])
    expect(await screen.findByText(translations.instructionsSkillsUpdateCheckFailed!)).toBeTruthy()
  })

  it('previews SKILL.md in-panel without leaving or opening the rightbar', async () => {
    const openResource = vi.fn()
    const onLeaveForPreview = vi.fn()
    const path = 'C:/Users/me/.agents/skills/demo/SKILL.md'
    vi.mocked(agentEnhancerListInstructionsSkills.invoke).mockResolvedValue(snapshot([
      skillRow({ id: 'demo', name: 'demo', path }),
    ]))
    vi.mocked(agentEnhancerReadSkillDocument.invoke).mockResolvedValue({
      path,
      absolutePath: path,
      text: '# demo\n\nbody paragraph',
      bytes: 24,
    })
    render(
      <InstructionsSkillsMainPanel
        {...panelProps({
          sidebarRight: () => ({ openResource }),
          onLeaveForPreview,
        })}
      />,
    )
    const row = await screen.findByRole('button', { name: /demo/i })
    fireEvent.click(row)
    expect(onLeaveForPreview).not.toHaveBeenCalled()
    expect(openResource).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(agentEnhancerReadSkillDocument.invoke).toHaveBeenCalled()
    })
    expect(await screen.findByRole('heading', { level: 2, name: 'demo' })).toBeTruthy()
    expect(screen.getByText('body paragraph')).toBeTruthy()
    expect(screen.queryByText(translations.instructionsSkillsPreviewEmpty!)).toBeNull()
  })

  it('open-in-sidebar leaves the panel then opens the official document tab', async () => {
    const openResource = vi.fn()
    const onLeaveForPreview = vi.fn()
    const path = 'C:/Users/me/.agents/skills/demo/SKILL.md'
    vi.mocked(agentEnhancerListInstructionsSkills.invoke).mockResolvedValue(snapshot([
      skillRow({ id: 'demo', name: 'demo', path }),
    ]))
    vi.mocked(agentEnhancerReadSkillDocument.invoke).mockResolvedValue({
      path,
      absolutePath: path,
      text: 'preview',
      bytes: 7,
    })
    render(
      <InstructionsSkillsMainPanel
        {...panelProps({
          sidebarRight: () => ({ openResource }),
          onLeaveForPreview,
        })}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /demo/i }))
    await screen.findByText('preview')
    fireEvent.click(screen.getByRole('button', { name: translations.instructionsSkillsOpenInSidebar! }))
    expect(onLeaveForPreview).toHaveBeenCalled()
    await waitFor(() => {
      expect(openResource).toHaveBeenCalled()
    })
  })

  it('keeps registry-only skills without a path non-interactive', async () => {
    await renderLoaded([
      skillRow({
        id: 'reg-only',
        name: 'ghost-skill',
        path: null,
        provider: 'registry',
      }),
    ])
    const row = await screen.findByRole('button', { name: /ghost-skill/i })
    expect((row as HTMLButtonElement).disabled).toBe(true)
  })
})
