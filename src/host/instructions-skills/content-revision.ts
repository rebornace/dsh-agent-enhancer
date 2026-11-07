import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

function listRelativeFiles(dir: string, root: string): string[] {
  const entries: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      entries.push(...listRelativeFiles(abs, root))
    } else if (entry.isFile()) {
      entries.push(relative(root, abs).split('\\').join('/'))
    }
  }
  return entries
}

export function contentRevisionOfDir(dir: string): string {
  const paths = listRelativeFiles(dir, dir).sort()
  const aggregate = createHash('sha256')
  for (const relPath of paths) {
    const contents = readFileSync(join(dir, relPath))
    const fileDigest = createHash('sha256').update(`${relPath}\0`).update(contents).digest()
    aggregate.update(fileDigest)
  }
  return aggregate.digest('hex')
}
