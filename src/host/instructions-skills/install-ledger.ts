import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type SkillInstallChannel = 'github' | 'zip'

export interface SkillInstallRecord {
  readonly name: string
  readonly channel: SkillInstallChannel
  readonly source: string | null
  readonly contentRevision: string | null
  readonly installedAt: string
  readonly updateCheck: boolean
}

export type InstallLedger = Record<string, SkillInstallRecord>

export function ledgerPath(dataRoot: string): string {
  return join(dataRoot, 'skills-install', 'registry.json')
}

function writeLedger(dataRoot: string, ledger: InstallLedger): void {
  const path = ledgerPath(dataRoot)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

export function readInstallLedger(dataRoot: string): InstallLedger {
  const path = ledgerPath(dataRoot)
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, 'utf8').trim()
    if (raw === '') return {}
    return JSON.parse(raw) as InstallLedger
  } catch {
    return {}
  }
}

export function upsertInstallRecord(dataRoot: string, record: SkillInstallRecord): void {
  const ledger = readInstallLedger(dataRoot)
  ledger[record.name] = record
  writeLedger(dataRoot, ledger)
}

export function removeInstallRecord(dataRoot: string, name: string): void {
  const ledger = readInstallLedger(dataRoot)
  delete ledger[name]
  writeLedger(dataRoot, ledger)
}
