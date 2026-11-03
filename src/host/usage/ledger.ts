import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { retainUsageCalls, summarizeUsage } from './summarize.ts'
import { USAGE_SOURCES } from './types.ts'
import type { UsageCall, UsageRange, UsageSummary } from './types.ts'

const callSchema = z.object({
  at: z.number().int().nonnegative(),
  source: z.enum(USAGE_SOURCES),
  provider: z.string().min(1),
  model: z.string().min(1),
  // Older ledgers omit effort; treat as unknown.
  reasoningEffort: z.string().optional().default(''),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
}).strict()

const fileSchema = z.object({
  schemaVersion: z.literal(1),
  calls: z.array(z.unknown()),
}).strict()

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = join(join(path, '..'), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await removeIfPresent(temporary)
  }
}

export class UsageLedger {
  private readonly file: string
  private tail: Promise<void> = Promise.resolve()
  private loaded = false
  private calls: UsageCall[] = []

  constructor(
    private readonly root: string,
    private readonly warn: (message: string) => void = () => {},
  ) {
    this.file = join(root, 'ledger.json')
  }

  record(call: UsageCall): void {
    void this.enqueue(() => this.append(call)).catch(() => {
      this.warn('agent-enhancer: model bill was not saved')
    })
  }

  summarize(range: UsageRange, now = Date.now()): Promise<UsageSummary> {
    return this.enqueue(async () => {
      await this.ensureLoaded()
      return summarizeUsage(this.calls, range, now)
    })
  }

  listCalls(): Promise<readonly UsageCall[]> {
    return this.enqueue(async () => {
      await this.ensureLoaded()
      return this.calls.map(call => ({ ...call }))
    })
  }

  flush(): Promise<void> {
    return this.enqueue(async () => undefined)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.calls = await this.read()
    this.loaded = true
  }

  private async read(): Promise<UsageCall[]> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return []
    }
    const file = fileSchema.safeParse(parsed)
    if (!file.success) return []
    const calls: UsageCall[] = []
    for (const item of file.data.calls) {
      const call = callSchema.safeParse(item)
      if (call.success) calls.push(call.data)
    }
    return calls
  }

  private async append(call: UsageCall): Promise<void> {
    await this.ensureLoaded()
    this.calls = retainUsageCalls([...this.calls, call], Date.now())
    await this.persist()
  }

  private async persist(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await writeAtomic(this.file, { schemaVersion: 1, calls: this.calls })
  }
}
