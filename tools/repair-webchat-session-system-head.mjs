#!/usr/bin/env node
/**
 * Repair a v4 session.v4.jsonl.zstd whose first surface is not system/message.
 * Inserts an inert createSystemMessage('') head and renumbers subsequent seqs.
 *
 * Usage:
 *   node tools/repair-webchat-session-system-head.mjs <path-to-session.v4.jsonl.zstd>
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const SURFACE = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

function decodeFramedZstd(buf) {
  const magics = []
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      magics.push(i)
    }
  }
  if (magics.length === 0) throw new Error('no zstd frames found')
  const events = []
  for (let i = 0; i < magics.length; i++) {
    const start = magics[i]
    const end = i + 1 < magics.length ? magics[i + 1] : buf.length
    let decoded
    try {
      decoded = zstdDecompressSync(buf.subarray(start, end))
    } catch {
      decoded = zstdDecompressSync(buf.subarray(start))
    }
    for (const line of decoded.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      events.push(JSON.parse(line))
    }
  }
  return events
}

function bumpSeqRefs(value, insertAt) {
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'number' && Number.isSafeInteger(item) && item >= insertAt) {
        return item + 1
      }
      return bumpSeqRefs(item, insertAt)
    })
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === 'seq' || key === 'startSeq' || key === 'endSeq' || key === 'cutSeq')
        && typeof child === 'number'
        && Number.isSafeInteger(child)
        && child >= insertAt
      ) {
        out[key] = child + 1
        continue
      }
      out[key] = bumpSeqRefs(child, insertAt)
    }
    return out
  }
  return value
}

function repair(events) {
  const header = events[0]
  if (!header || header.type !== 'session') {
    throw new Error('expected session header as first event')
  }
  const body = events.slice(1)
  const firstSurfaceIdx = body.findIndex(event => SURFACE.has(event.type))
  if (firstSurfaceIdx < 0) {
    throw new Error('no surface events to repair')
  }
  if (body[firstSurfaceIdx].type === 'system/message') {
    return { events, changed: false }
  }

  const insertAt = typeof body[firstSurfaceIdx].seq === 'number'
    ? body[firstSurfaceIdx].seq
    : firstSurfaceIdx

  // Prefer turn/step from the enclosing step/start just before the first surface.
  let turn = 1
  let step = 1
  for (let i = firstSurfaceIdx - 1; i >= 0; i--) {
    if (body[i].type === 'step/start' && body[i].data) {
      turn = Number(body[i].data.turn) || 1
      step = Number(body[i].data.step) || 1
      break
    }
  }

  const head = {
    type: 'system/message',
    seq: insertAt,
    time: Date.now(),
    data: {
      turn,
      step,
      message: {
        role: 'system',
        content: [],
        source: { kind: 'system-prompt' },
        id: randomUUID(),
      },
    },
    surfaceOp: 'append',
  }

  const repairedBody = body.map(event => bumpSeqRefs(event, insertAt))
  repairedBody.splice(firstSurfaceIdx, 0, head)
  return { events: [header, ...repairedBody], changed: true }
}

function encodeFramedZstd(events) {
  // One JSONL line per zstd frame — matches Desktop's observed layout.
  const frames = events.map(event => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')))
  return Buffer.concat(frames)
}

const target = process.argv[2]
if (!target) {
  console.error('Usage: node tools/repair-webchat-session-system-head.mjs <session.v4.jsonl.zstd>')
  process.exit(1)
}

const original = readFileSync(target)
const decoded = decodeFramedZstd(original)
const { events, changed } = repair(decoded)
if (!changed) {
  console.log('Already has system/message head; no change.')
  process.exit(0)
}
const backup = `${target}.bak-${Date.now()}`
copyFileSync(target, backup)
writeFileSync(target, encodeFramedZstd(events))
console.log(`Repaired ${target}`)
console.log(`Backup: ${backup}`)
console.log(`Events: ${decoded.length} → ${events.length}`)
