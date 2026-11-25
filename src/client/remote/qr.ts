/**
 * Minimal QR encoder (byte mode, error correction M).
 *
 * The WeChat login hands back a URL that must be drawn as a QR code; the
 * plugin should not pull a QR library in for one screen, and the URL is always
 * short. Versions 1–20 are far more than a login URL needs (v20-M holds ~660
 * bytes), so the tables stay small and auditable.
 *
 * The tables (RS block layout, alignment positions) are the published QR
 * standard values; the algorithm follows ISO/IEC 18004 byte mode.
 */

export interface QrMatrix {
  readonly version: number
  readonly size: number
  /** `rows[y][x]` — true means a dark module. No quiet zone is included. */
  readonly rows: readonly (readonly boolean[])[]
}

export interface QrOptions {
  /** Defaults to M (15% recovery), the usual choice for screen scanning. */
  readonly ecc?: 'L' | 'M' | 'Q' | 'H'
  /** Skip mask scoring (tests only); production always scores. */
  readonly mask?: number
}

type Ecc = 'L' | 'M' | 'Q' | 'H'

/** ECC level indicator bits used in the format information. */
const ECC_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 }

/**
 * RS blocks per version (rows 1..20) and ECC level, as groups of
 * `count, totalCodewords, dataCodewords`.
 */
const RS_BLOCKS: Record<Ecc, readonly (readonly number[])[]> = {
  L: [
    [1, 26, 19], [1, 44, 34], [1, 70, 55], [1, 100, 80], [1, 134, 108],
    [2, 86, 68], [2, 98, 78], [2, 121, 97], [2, 146, 116], [2, 86, 68, 2, 87, 69],
    [4, 101, 81], [2, 116, 92, 2, 117, 93], [4, 133, 107], [3, 145, 115, 1, 146, 116],
    [5, 109, 87, 1, 110, 88], [5, 122, 98, 1, 123, 99], [1, 135, 107, 5, 136, 108],
    [5, 150, 120, 1, 151, 121], [3, 141, 113, 4, 142, 114], [3, 135, 107, 5, 136, 108],
  ],
  M: [
    [1, 26, 16], [1, 44, 28], [1, 70, 44], [2, 50, 32], [2, 67, 43],
    [4, 43, 27], [4, 49, 31], [2, 60, 38, 2, 61, 39], [3, 58, 36, 2, 59, 37],
    [4, 69, 43, 1, 70, 44], [1, 80, 50, 4, 81, 51], [6, 58, 36, 2, 59, 37],
    [8, 59, 37, 1, 60, 38], [4, 64, 40, 5, 65, 41], [5, 65, 41, 5, 66, 42],
    [7, 73, 45, 3, 74, 46], [10, 74, 46, 1, 75, 47], [9, 69, 43, 4, 70, 44],
    [3, 70, 44, 11, 71, 45], [3, 67, 41, 13, 68, 42],
  ],
  Q: [
    [1, 26, 13], [1, 44, 22], [2, 35, 17], [2, 50, 24], [2, 33, 15, 2, 34, 16],
    [4, 43, 19], [2, 32, 14, 4, 33, 15], [4, 40, 18, 2, 41, 19], [4, 36, 16, 4, 37, 17],
    [6, 43, 19, 2, 44, 20], [4, 50, 22, 4, 51, 23], [4, 46, 20, 6, 47, 21],
    [8, 44, 20, 4, 45, 21], [11, 36, 16, 5, 37, 17], [5, 54, 24, 7, 55, 25],
    [15, 43, 19, 2, 44, 20], [1, 50, 22, 15, 51, 23], [17, 50, 22, 1, 51, 23],
    [17, 47, 21, 4, 48, 22], [15, 54, 24, 5, 55, 25],
  ],
  H: [
    [1, 26, 9], [1, 44, 16], [2, 35, 13], [4, 25, 9], [2, 33, 11, 2, 34, 12],
    [4, 43, 15], [4, 39, 13, 1, 40, 14], [4, 40, 14, 2, 41, 15], [4, 36, 12, 4, 37, 13],
    [6, 43, 15, 2, 44, 16], [3, 36, 12, 8, 37, 13], [7, 42, 14, 4, 43, 15],
    [12, 33, 11, 4, 34, 12], [11, 36, 12, 5, 37, 13], [11, 36, 12, 7, 37, 13],
    [3, 45, 15, 13, 46, 16], [2, 42, 14, 17, 43, 15], [2, 42, 14, 19, 43, 15],
    [9, 39, 13, 16, 40, 14], [15, 43, 15, 10, 44, 16],
  ],
}

/** Alignment pattern centres per version (row 1 is empty). */
const ALIGN_POSITIONS: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
  [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
  [6, 34, 62, 90],
]

const MAX_VERSION = 20
const G15 = 0b101_0011_0111 // x^10 + x^8 + x^5 + x^4 + x^2 + x + 1
const G18 = 0b1_1111_0010_0101 // x^12 + x^11 + x^10 + x^9 + x^8 + x^5 + x^2 + 1
const FORMAT_MASK = 0b101_0100_0001_0010

interface RsGroup {
  readonly count: number
  readonly total: number
  readonly data: number
}

function rsGroups(version: number, ecc: Ecc): RsGroup[] {
  const row = RS_BLOCKS[ecc][version - 1]
  if (row === undefined) throw new Error(`QR version ${version} is not supported`)
  const groups: RsGroup[] = []
  for (let i = 0; i < row.length; i += 3) {
    groups.push({ count: row[i] ?? 0, total: row[i + 1] ?? 0, data: row[i + 2] ?? 0 })
  }
  return groups
}

/** Data codewords available at this version/level. */
function dataCodewords(version: number, ecc: Ecc): number {
  return rsGroups(version, ecc).reduce((sum, group) => sum + group.count * group.data, 0)
}

function byteLengthBits(version: number): number {
  return version < 10 ? 8 : 16
}

function utf8Bytes(text: string): number[] {
  const encoded = new TextEncoder().encode(text)
  const bytes: number[] = []
  for (const byte of encoded) bytes.push(byte)
  return bytes
}

class BitBuffer {
  private readonly bits: number[] = []

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1)
  }

  get length(): number {
    return this.bits.length
  }

  toBytes(): number[] {
    const bytes: number[] = []
    for (let i = 0; i < this.bits.length; i += 8) {
      let value = 0
      for (let j = 0; j < 8; j += 1) value = (value << 1) | (this.bits[i + j] ?? 0)
      bytes.push(value)
    }
    return bytes
  }
}

/** GF(256) log/exp tables for the QR polynomial field (0x11D). */
const GF_EXP: number[] = new Array(512)
const GF_LOG: number[] = new Array(256).fill(0)
;(() => {
  let value = 1
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value
    GF_LOG[value] = i
    value <<= 1
    if ((value & 0x100) !== 0) value ^= 0x11D
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255] ?? 0
})()

function gfMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0
  return GF_EXP[(GF_LOG[left] ?? 0) + (GF_LOG[right] ?? 0)] ?? 0
}

function generatorPolynomial(degree: number): number[] {
  let generator = [1]
  for (let i = 0; i < degree; i += 1) {
    const root = GF_EXP[i] ?? 0
    const next = new Array<number>(generator.length + 1).fill(0)
    for (let k = 0; k < generator.length; k += 1) {
      next[k] = (next[k] ?? 0) ^ (generator[k] ?? 0)
      next[k + 1] = (next[k + 1] ?? 0) ^ gfMultiply(root, generator[k] ?? 0)
    }
    generator = next
  }
  return generator
}

function errorCorrection(data: readonly number[], degree: number): number[] {
  const generator = generatorPolynomial(degree)
  const remainder = new Array<number>(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0)
    remainder.shift()
    remainder.push(0)
    if (factor === 0) continue
    for (let i = 0; i < degree; i += 1) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMultiply(generator[i + 1] ?? 0, factor)
    }
  }
  return remainder
}

function pickVersion(byteCount: number, ecc: Ecc): number {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const capacity = dataCodewords(version, ecc) * 8
    const needed = 4 + byteLengthBits(version) + byteCount * 8
    if (needed <= capacity) return version
  }
  throw new Error('内容太长，无法生成二维码')
}

function dataBytes(bytes: readonly number[], version: number, ecc: Ecc): number[] {
  const capacity = dataCodewords(version, ecc)
  const buffer = new BitBuffer()
  buffer.push(0b0100, 4) // byte mode
  buffer.push(bytes.length, byteLengthBits(version))
  for (const byte of bytes) buffer.push(byte, 8)

  const capacityBits = capacity * 8
  const terminator = Math.min(4, capacityBits - buffer.length)
  if (terminator > 0) buffer.push(0, terminator)
  while (buffer.length % 8 !== 0) buffer.push(0, 1)

  const out = buffer.toBytes()
  const pad = [0xEC, 0x11]
  let index = 0
  while (out.length < capacity) {
    out.push(pad[index % 2] ?? 0)
    index += 1
  }
  return out
}

function interleave(data: readonly number[], version: number, ecc: Ecc): number[] {
  const groups = rsGroups(version, ecc)
  const dataBlocks: number[][] = []
  const ecBlocks: number[][] = []
  let offset = 0
  for (const group of groups) {
    for (let i = 0; i < group.count; i += 1) {
      const block = data.slice(offset, offset + group.data)
      offset += group.data
      dataBlocks.push(block)
      ecBlocks.push(errorCorrection(block, group.total - group.data))
    }
  }

  const out: number[] = []
  const maxData = Math.max(...dataBlocks.map(block => block.length))
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) out.push(block[i] ?? 0)
    }
  }
  const maxEc = Math.max(...ecBlocks.map(block => block.length))
  for (let i = 0; i < maxEc; i += 1) {
    for (const block of ecBlocks) {
      if (i < block.length) out.push(block[i] ?? 0)
    }
  }
  return out
}

function bchRemainder(value: number, generator: number): number {
  let remainder = value
  const digit = (input: number): number => {
    let bits = 0
    let current = input
    while (current !== 0) {
      bits += 1
      current >>>= 1
    }
    return bits
  }
  while (digit(remainder) >= digit(generator)) {
    remainder ^= generator << (digit(remainder) - digit(generator))
  }
  return remainder
}

function formatBits(ecc: Ecc, mask: number): number {
  const data = (ECC_BITS[ecc] << 3) | mask
  return ((data << 10) | bchRemainder(data << 10, G15)) ^ FORMAT_MASK
}

function versionBits(version: number): number {
  return (version << 12) | bchRemainder(version << 12, G18)
}

const MASK_FUNCTIONS: readonly ((row: number, col: number) => boolean)[] = [
  (row, col) => (row + col) % 2 === 0,
  (row, _col) => row % 2 === 0,
  (_row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row * col) % 3) + ((row + col) % 2)) % 2 === 0,
]

class QrGrid {
  readonly dark: boolean[][]
  readonly reserved: boolean[][]

  constructor(readonly size: number) {
    this.dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    this.reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }

  set(y: number, x: number, value: boolean): void {
    if (y < 0 || x < 0 || y >= this.size || x >= this.size) return
    this.dark[y]![x] = value
    this.reserved[y]![x] = true
  }

  isDark(y: number, x: number): boolean {
    return this.dark[y]?.[x] === true
  }

  isReserved(y: number, x: number): boolean {
    return this.reserved[y]?.[x] === true
  }
}

function drawFinder(grid: QrGrid, originY: number, originX: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const y = originY + dy
      const x = originX + dx
      if (y < 0 || x < 0 || y >= grid.size || x >= grid.size) continue
      const inside = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6
      const dark = inside
        && (dy === 0 || dy === 6 || dx === 0 || dx === 6
          || (dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4))
      grid.set(y, x, dark)
    }
  }
}

function drawAlignment(grid: QrGrid, centerY: number, centerX: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const distance = Math.max(Math.abs(dy), Math.abs(dx))
      grid.set(centerY + dy, centerX + dx, distance !== 1)
    }
  }
}

function drawFunctionPatterns(grid: QrGrid, version: number): void {
  const size = grid.size
  drawFinder(grid, 0, 0)
  drawFinder(grid, 0, size - 7)
  drawFinder(grid, size - 7, 0)

  for (let i = 8; i < size - 8; i += 1) {
    grid.set(6, i, i % 2 === 0)
    grid.set(i, 6, i % 2 === 0)
  }

  const positions = ALIGN_POSITIONS[version - 1] ?? []
  const last = positions.length - 1
  for (let rowIndex = 0; rowIndex <= last; rowIndex += 1) {
    for (let colIndex = 0; colIndex <= last; colIndex += 1) {
      const corner = (rowIndex === 0 && colIndex === 0)
        || (rowIndex === 0 && colIndex === last)
        || (rowIndex === last && colIndex === 0)
      if (corner) continue
      drawAlignment(grid, positions[rowIndex] ?? 0, positions[colIndex] ?? 0)
    }
  }

  // Format information areas and the fixed dark module. Row/column 6 is the
  // timing pattern and must stay untouched.
  for (let i = 0; i < 9; i += 1) {
    if (i === 6) continue
    grid.set(8, i, false)
    grid.set(i, 8, false)
  }
  for (let i = 0; i < 8; i += 1) {
    grid.set(8, size - 1 - i, false)
    grid.set(size - 1 - i, 8, false)
  }
  grid.set(size - 8, 8, true)

  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      grid.set(Math.floor(i / 3), i % 3 + size - 11, false)
      grid.set(i % 3 + size - 11, Math.floor(i / 3), false)
    }
  }
}

function placeFormatInfo(grid: QrGrid, ecc: Ecc, mask: number): void {
  const bits = formatBits(ecc, mask)
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1
    if (i < 6) grid.set(i, 8, dark)
    else if (i < 8) grid.set(i + 1, 8, dark)
    else grid.set(grid.size - 15 + i, 8, dark)
  }
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1
    if (i < 8) grid.set(8, grid.size - 1 - i, dark)
    else if (i < 9) grid.set(8, 15 - i, dark)
    else grid.set(8, 15 - i - 1, dark)
  }
  grid.set(grid.size - 8, 8, true)
}

function placeVersionInfo(grid: QrGrid, version: number): void {
  if (version < 7) return
  const bits = versionBits(version)
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >> i) & 1) === 1
    grid.set(Math.floor(i / 3), i % 3 + grid.size - 11, dark)
    grid.set(i % 3 + grid.size - 11, Math.floor(i / 3), dark)
  }
}

function placeData(grid: QrGrid, codewords: readonly number[], mask: number): void {
  const isMasked = MASK_FUNCTIONS[mask] ?? MASK_FUNCTIONS[0]!
  let byteIndex = 0
  let bitIndex = 7
  let row = grid.size - 1
  let direction = -1

  for (let col = grid.size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1
    for (;;) {
      for (let offset = 0; offset < 2; offset += 1) {
        const x = col - offset
        if (grid.isReserved(row, x)) continue
        let dark = false
        if (byteIndex < codewords.length) {
          dark = ((codewords[byteIndex]! >>> bitIndex) & 1) === 1
        }
        if (isMasked(row, x)) dark = !dark
        grid.dark[row]![x] = dark
        bitIndex -= 1
        if (bitIndex < 0) {
          bitIndex = 7
          byteIndex += 1
        }
      }
      row += direction
      if (row < 0 || row >= grid.size) {
        row -= direction
        direction = -direction
        break
      }
    }
  }
}

function penalty(grid: QrGrid): number {
  const size = grid.size
  let score = 0

  // Rule 1: runs of five or more same-coloured modules in a line.
  const scoreLine = (values: readonly boolean[]): void => {
    let run = 1
    for (let i = 1; i <= values.length; i += 1) {
      if (i < values.length && values[i] === values[i - 1]) {
        run += 1
        continue
      }
      if (run >= 5) score += 3 + (run - 5)
      run = 1
    }
  }
  for (let y = 0; y < size; y += 1) scoreLine(grid.dark[y] ?? [])
  for (let x = 0; x < size; x += 1) {
    scoreLine(Array.from({ length: size }, (_, y) => grid.isDark(y, x)))
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const dark = grid.isDark(y, x)
      if (grid.isDark(y, x + 1) === dark && grid.isDark(y + 1, x) === dark && grid.isDark(y + 1, x + 1) === dark) {
        score += 3
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 sequences.
  const isFinderLike = (values: readonly boolean[], start: number): boolean =>
    values[start] === true
    && values[start + 1] === false
    && values[start + 2] === true
    && values[start + 3] === true
    && values[start + 4] === true
    && values[start + 5] === false
    && values[start + 6] === true
  for (let y = 0; y < size; y += 1) {
    const row = grid.dark[y] ?? []
    for (let x = 0; x + 6 < size; x += 1) {
      if (isFinderLike(row, x)) score += 40
    }
  }
  for (let x = 0; x < size; x += 1) {
    const column = Array.from({ length: size }, (_, y) => grid.isDark(y, x))
    for (let y = 0; y + 6 < size; y += 1) {
      if (isFinderLike(column, y)) score += 40
    }
  }

  // Rule 4: deviation of the dark ratio from 50%.
  let darkCount = 0
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) if (grid.isDark(y, x)) darkCount += 1
  }
  const ratio = Math.abs((100 * darkCount) / (size * size) - 50) / 5
  score += Math.floor(ratio) * 10
  return score
}

function renderWithMask(codewords: readonly number[], version: number, ecc: Ecc, mask: number): QrGrid {
  const grid = new QrGrid(17 + 4 * version)
  drawFunctionPatterns(grid, version)
  placeVersionInfo(grid, version)
  placeData(grid, codewords, mask)
  placeFormatInfo(grid, ecc, mask)
  return grid
}

export function encodeQr(text: string, options: QrOptions = {}): QrMatrix {
  const ecc = options.ecc ?? 'M'
  if (text === '') throw new Error('内容为空，无法生成二维码')
  const bytes = utf8Bytes(text)
  const version = pickVersion(bytes.length, ecc)
  const codewords = interleave(dataBytes(bytes, version, ecc), version, ecc)

  let bestMask = options.mask ?? 0
  if (options.mask === undefined) {
    let bestScore = Number.POSITIVE_INFINITY
    for (let mask = 0; mask < 8; mask += 1) {
      const score = penalty(renderWithMask(codewords, version, ecc, mask))
      if (score < bestScore) {
        bestScore = score
        bestMask = mask
      }
    }
  }

  const final = renderWithMask(codewords, version, ecc, bestMask)
  return { version, size: final.size, rows: final.dark.map(row => [...row]) }
}

/** One `<path>` d for the dark modules, with the quiet zone included. */
export function qrModulesPath(matrix: QrMatrix, quietZone = 4): string {
  const offset = quietZone
  const parts: string[] = []
  for (let y = 0; y < matrix.size; y += 1) {
    const row = matrix.rows[y] ?? []
    for (let x = 0; x < matrix.size; x += 1) {
      if (row[x] !== true) continue
      parts.push(`M${x + offset} ${y + offset}h1v1h-1z`)
    }
  }
  return parts.join(' ')
}
