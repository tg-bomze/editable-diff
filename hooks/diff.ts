// Line diff shared by the hooks module and the editor. Pure: no `$`, no state.

export type RowKind = 'ctx' | 'add' | 'del'

/** One row of a unified diff. `oldNo`/`newNo` are 1-based, 0 where absent. */
export type Row = { kind: RowKind; text: string; oldNo: number; newNo: number }

/** Lines of text vs base, one patch hunk: at text line `at`, `del` text lines stand for the base lines `ins`. */
export type Patch = [at: number, del: number, ins: string[]][]

export const CONTEXT = 5

/** Regions past this many line pairs split at their unique lines before Myers runs. */
const PATIENCE_CELLS = 1_000_000

/** The longest run of `pairs` (sorted by their first) whose seconds increase too: patience sorting. */
function increasing(pairs: readonly [number, number][]): [number, number][] {
  const tops: number[] = []
  const back = new Int32Array(pairs.length)
  for (let p = 0; p < pairs.length; p++) {
    const j = pairs[p]![1]
    let lo = 0
    let hi = tops.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (pairs[tops[mid]!]![1] < j) lo = mid + 1
      else hi = mid
    }
    back[p] = lo > 0 ? tops[lo - 1]! : -1
    tops[lo] = p
  }
  const out: [number, number][] = []
  for (let p = tops.length ? tops[tops.length - 1]! : -1; p >= 0; p = back[p]!) out.push(pairs[p]!)

  return out.reverse()
}

/** Past this much work (snake steps) a diff gives up and shows the middle as all removed then all added. */
const MAX_WORK = 10_000_000

export function splitLines(text: string): string[] {
  return text.split('\n')
}

export type DiffOptions = {
  /** Lines that differ only in whitespace count as unchanged. */
  ignoreWhitespace?: boolean
}

const squeeze = (line: string) => line.replace(/\s+/g, ' ').trim()

export function diffLines(a: readonly string[], b: readonly string[], options: DiffOptions = {}): Row[] {
  const ka = options.ignoreWhitespace ? a.map(squeeze) : a
  const kb = options.ignoreWhitespace ? b.map(squeeze) : b
  let start = 0
  while (start < a.length && start < b.length && ka[start] === kb[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) {
    endA--
    endB--
  }

  const rows: Row[] = []
  for (let i = 0; i < start; i++) rows.push({ kind: 'ctx', text: b[i]!, oldNo: i + 1, newNo: i + 1 })

  const ops = middleOps(ka, kb, start, endA, endB)
  if (ops) {
    let i = start
    let j = start
    for (const op of ops) {
      if (op === 0) {
        rows.push({ kind: 'ctx', text: b[j]!, oldNo: i + 1, newNo: j + 1 })
        i++
        j++
      } else if (op === 1) {
        rows.push({ kind: 'add', text: b[j]!, oldNo: 0, newNo: j + 1 })
        j++
      } else {
        rows.push({ kind: 'del', text: a[i]!, oldNo: i + 1, newNo: 0 })
        i++
      }
    }
    // Within a change, show the removed lines above the added ones.
    return [...rows.slice(0, start), ...groupChanges(rows.slice(start)), ...suffix(b, endA, endB)]
  }

  for (let i = start; i < endA; i++) rows.push({ kind: 'del', text: a[i]!, oldNo: i + 1, newNo: 0 })
  for (let j = start; j < endB; j++) rows.push({ kind: 'add', text: b[j]!, oldNo: 0, newNo: j + 1 })

  return [...rows, ...suffix(b, endA, endB)]
}

/**
 * The edit script for a[start, endA) against b[start, endB): 0 keep, 1 add, 2
 * remove, in order. Myers' O(ND) diff in linear space, as git's: its cost
 * grows with how much differs, not with the size of the file. Undefined past
 * MAX_WORK.
 */
function middleOps(
  a: readonly string[],
  b: readonly string[],
  start: number,
  endA: number,
  endB: number,
): Uint8Array | undefined {
  // Lines as numbers, so comparing two is one step.
  const ids = new Map<string, number>()
  const idOf = (line: string) => {
    let id = ids.get(line)
    if (id === undefined) ids.set(line, (id = ids.size))
    return id
  }
  const x = Int32Array.from(a.slice(start, endA), idOf)
  const shared = ids.size
  const y = Int32Array.from(b.slice(start, endB), idOf)
  const ops = new Uint8Array(x.length + y.length)
  // No line in common: all of one removed, all of the other added, with no search.
  if (y.every(id => id >= shared)) return ops.fill(2, 0, x.length).fill(1, x.length)
  let at = 0
  let work = 0
  const emit = (op: number, count: number) => {
    ops.fill(op, at, at + count)
    at += count
  }

  // Where a shortest edit path of x[lo1, hi1) against y[lo2, hi2) crosses its middle diagonal band.
  const bisect = (lo1: number, hi1: number, lo2: number, hi2: number): [number, number] | undefined => {
    const n = hi1 - lo1
    const m = hi2 - lo2
    const max = Math.ceil((n + m) / 2)
    const offset = max + 1
    const size = 2 * max + 3
    const v1 = new Int32Array(size).fill(-1)
    const v2 = new Int32Array(size).fill(-1)
    v1[offset + 1] = 0
    v2[offset + 1] = 0
    const delta = n - m
    const isFront = delta % 2 !== 0
    let k1start = 0
    let k1end = 0
    let k2start = 0
    let k2end = 0
    for (let d = 0; d < max; d++) {
      for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
        const i1 = offset + k1
        let x1 = k1 === -d || (k1 !== d && v1[i1 - 1]! < v1[i1 + 1]!) ? v1[i1 + 1]! : v1[i1 - 1]! + 1
        let y1 = x1 - k1
        const from1 = x1
        while (x1 < n && y1 < m && x[lo1 + x1] === y[lo2 + y1]) {
          x1++
          y1++
        }
        work += 1 + x1 - from1
        v1[i1] = x1
        if (x1 > n) k1end += 2
        else if (y1 > m) k1start += 2
        else if (isFront) {
          const i2 = offset + delta - k1
          if (i2 >= 0 && i2 < size && v2[i2] !== -1 && x1 >= n - v2[i2]!) return [x1, y1]
        }
      }
      for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
        const i2 = offset + k2
        let x2 = k2 === -d || (k2 !== d && v2[i2 - 1]! < v2[i2 + 1]!) ? v2[i2 + 1]! : v2[i2 - 1]! + 1
        let y2 = x2 - k2
        const from2 = x2
        while (x2 < n && y2 < m && x[hi1 - x2 - 1] === y[hi2 - y2 - 1]) {
          x2++
          y2++
        }
        work += 1 + x2 - from2
        v2[i2] = x2
        if (x2 > n) k2end += 2
        else if (y2 > m) k2start += 2
        else if (!isFront) {
          const i1 = offset + delta - k2
          if (i1 >= 0 && i1 < size && v1[i1] !== -1) {
            const x1 = v1[i1]!
            if (x1 >= n - x2) return [x1, offset + x1 - i1]
          }
        }
      }
      if (work > MAX_WORK) throw RangeError('diff too large')
    }

    return undefined
  }

  const walk = (lo1: number, hi1: number, lo2: number, hi2: number): void => {
    let pre = 0
    while (lo1 + pre < hi1 && lo2 + pre < hi2 && x[lo1 + pre] === y[lo2 + pre]) pre++
    let post = 0
    while (hi1 - post > lo1 + pre && hi2 - post > lo2 + pre && x[hi1 - post - 1] === y[hi2 - post - 1]) post++
    emit(0, pre)
    lo1 += pre
    lo2 += pre
    hi1 -= post
    hi2 -= post
    if (lo1 === hi1) emit(1, hi2 - lo2)
    else if (lo2 === hi2) emit(2, hi1 - lo1)
    else {
      const mid = bisect(lo1, hi1, lo2, hi2)
      if (mid) {
        walk(lo1, lo1 + mid[0], lo2, lo2 + mid[1])
        walk(lo1 + mid[0], hi1, lo2 + mid[1], hi2)
      } else {
        emit(2, hi1 - lo1)
        emit(1, hi2 - lo2)
      }
    }
    emit(0, post)
  }

  // A large region first splits at the lines found once on each side, in order (patience diff), as git
  // --patience does: Myers then runs between them, on pieces small enough to stay fast.
  const split = (lo1: number, hi1: number, lo2: number, hi2: number): void => {
    if ((hi1 - lo1) * (hi2 - lo2) <= PATIENCE_CELLS) return walk(lo1, hi1, lo2, hi2)
    const once = (ids: Int32Array, lo: number, hi: number) => {
      const at = new Map<number, number>()
      for (let i = lo; i < hi; i++) at.set(ids[i]!, at.has(ids[i]!) ? -1 : i)
      return at
    }
    const inX = once(x, lo1, hi1)
    const inY = once(y, lo2, hi2)
    const pairs: [number, number][] = []
    for (let i = lo1; i < hi1; i++) {
      const j = inY.get(x[i]!)
      if (inX.get(x[i]!) === i && j !== undefined && j >= 0) pairs.push([i, j])
    }
    const anchors = increasing(pairs)
    if (!anchors.length) return walk(lo1, hi1, lo2, hi2)
    let i = lo1
    let j = lo2
    for (const [ai, aj] of anchors) {
      split(i, ai, j, aj)
      emit(0, 1)
      i = ai + 1
      j = aj + 1
    }
    split(i, hi1, j, hi2)
  }

  try {
    split(0, x.length, 0, y.length)
  } catch (error) {
    if (error instanceof RangeError) return undefined
    throw error
  }

  return ops.subarray(0, at)
}

function suffix(b: readonly string[], endA: number, endB: number): Row[] {
  const rows: Row[] = []
  for (let k = 0; endB + k < b.length; k++) {
    rows.push({ kind: 'ctx', text: b[endB + k]!, oldNo: endA + k + 1, newNo: endB + k + 1 })
  }

  return rows
}

function groupChanges(rows: Row[]): Row[] {
  const out: Row[] = []
  let dels: Row[] = []
  let adds: Row[] = []
  const flush = () => {
    out.push(...dels, ...adds)
    dels = []
    adds = []
  }
  for (const row of rows) {
    if (row.kind === 'ctx') {
      flush()
      out.push(row)
    } else if (row.kind === 'del') dels.push(row)
    else adds.push(row)
  }
  flush()

  return out
}

export function countChanges(rows: readonly Row[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const row of rows) {
    if (row.kind === 'add') added++
    else if (row.kind === 'del') removed++
  }

  return { added, removed }
}

/** The changes as [start, end) row ranges: each a run of removed and added rows between unchanged ones. */
export function changeBlocks(rows: readonly Row[]): [number, number][] {
  const out: [number, number][] = []
  for (let k = 0; k < rows.length; k++) {
    if (rows[k]!.kind === 'ctx') continue
    const start = k
    while (k + 1 < rows.length && rows[k + 1]!.kind !== 'ctx') k++
    out.push([start, k + 1])
  }

  return out
}

/**
 * A character that draws as nothing or hides what the text around it says:
 * C1 controls, zero-width spaces, line separators, bidirectional overrides
 * and isolates ("Trojan Source"), a byte order mark past the start.
 */
export const isHiddenChar = (code: number) =>
  (code >= 0x80 && code <= 0x9f) ||
  code === 0x200b ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x2028 && code <= 0x202e) ||
  (code >= 0x2060 && code <= 0x2064) ||
  (code >= 0x2066 && code <= 0x2069) ||
  code === 0xfeff

/** `text` safe to draw on one line: control and hidden characters, and unpaired surrogates, become `�`. */
export function printable(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    out += code < 32 || code === 127 || isHiddenChar(code) || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : ch
  }

  return out
}

/** A letter, digit, `_` or `$`: what a word is made of, for change marks and double-click. */
export const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_$]/u.test(c)

/**
 * The changed span inside each removed line paired with an added one (the
 * i-th removed line of a change with its i-th added line), by row index, as
 * [start, end) in the row's text. Lines with nothing in common get no span.
 */
export function wordRanges(rows: readonly Row[]): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>()
  let k = 0
  while (k < rows.length) {
    if (rows[k]!.kind === 'ctx') {
      k++
      continue
    }
    const dels: number[] = []
    const adds: number[] = []
    while (k < rows.length && rows[k]!.kind !== 'ctx') {
      ;(rows[k]!.kind === 'del' ? dels : adds).push(k)
      k++
    }
    for (let i = 0; i < Math.min(dels.length, adds.length); i++) {
      const a = rows[dels[i]!]!.text
      const b = rows[adds[i]!]!.text
      let start = 0
      while (start < a.length && start < b.length && a[start] === b[start]) start++
      let endA = a.length
      let endB = b.length
      while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--
        endB--
      }
      // Whole words, as GitHub marks them: `let` → `const` marks both words, not `le` and `cons`.
      while (start > 0 && isWordChar(a[start - 1]) && (isWordChar(a[start]) || isWordChar(b[start]))) start--
      while (
        endA < a.length &&
        endB < b.length &&
        isWordChar(a[endA]) &&
        (isWordChar(a[endA - 1]) || isWordChar(b[endB - 1]))
      ) {
        endA++
        endB++
      }
      // Only worth marking when the lines share a good part.
      const kept = start + (a.length - endA)
      if (kept * 3 < Math.max(a.length, b.length)) continue
      if (endA > start) out.set(dels[i]!, [start, endA])
      if (endB > start) out.set(adds[i]!, [start, endB])
    }
  }

  return out
}

/** Indices of the rows to show: every change, CONTEXT rows around it, and `pinned` rows. */
export function visibleRows(rows: readonly Row[], pinned: ReadonlySet<number> = new Set()): number[] {
  const show = new Uint8Array(rows.length)
  rows.forEach((row, k) => {
    if (row.kind !== 'ctx') {
      for (let d = Math.max(0, k - CONTEXT); d <= Math.min(rows.length - 1, k + CONTEXT); d++) show[d] = 1
    }
  })
  for (const k of pinned) if (k >= 0 && k < rows.length) show[k] = 1
  const out: number[] = []
  show.forEach((on, k) => {
    if (on) out.push(k)
  })

  return out
}

/** A line safe for a surface's own code element: tab its only control character. */
const codeLine = (line: string) => line.replace(/\r$/, '').split('\t').map(printable).join('\t')

/**
 * The rows as unified-diff hunks (`@@ -a,b +c,d @@`) with CONTEXT lines
 * around each change, as many whole hunks as fit in `max` characters.
 */
export function unifiedDiff(rows: readonly Row[], max: number): { text: string; hunks: number; shown: number } {
  const visible = visibleRows(rows)
  const runs: number[][] = []
  for (const k of visible) {
    const run = runs[runs.length - 1]
    if (run && run[run.length - 1] === k - 1) run.push(k)
    else runs.push([k])
  }
  let text = ''
  let shown = 0
  for (const run of runs) {
    let oldBefore = 0
    let newBefore = 0
    for (let k = run[0]! - 1; k >= 0 && (!oldBefore || !newBefore); k--) {
      if (!oldBefore && rows[k]!.oldNo) oldBefore = rows[k]!.oldNo
      if (!newBefore && rows[k]!.newNo) newBefore = rows[k]!.newNo
    }
    const part = run.map(k => rows[k]!)
    const oldCount = part.filter(r => r.kind !== 'add').length
    const newCount = part.filter(r => r.kind !== 'del').length
    const oldStart = part.find(r => r.oldNo)?.oldNo ?? oldBefore
    const newStart = part.find(r => r.newNo)?.newNo ?? newBefore
    const sign = { ctx: ' ', add: '+', del: '-' } as const
    const hunk =
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n` +
      part.map(r => sign[r.kind] + codeLine(r.text)).join('\n') +
      '\n'
    if (text.length + hunk.length > max) break
    text += hunk
    shown++
  }

  return { text: text.replace(/\n$/, ''), hunks: runs.length, shown }
}

/** What turns `text` back into `base`: the hunks of base lines standing for text lines. */
export function makePatch(base: string, text: string): Patch {
  const rows = diffLines(splitLines(base), splitLines(text))
  const patch: Patch = []
  let textLine = 0
  let k = 0
  while (k < rows.length) {
    const row = rows[k]!
    if (row.kind === 'ctx') {
      textLine++
      k++
      continue
    }
    const at = textLine
    let del = 0
    const ins: string[] = []
    while (k < rows.length && rows[k]!.kind !== 'ctx') {
      if (rows[k]!.kind === 'add') del++
      else ins.push(rows[k]!.text)
      k++
    }
    patch.push([at, del, ins])
    textLine += del
  }

  return patch
}

export function applyPatch(textLines: readonly string[], patch: Patch): string[] {
  const out: string[] = []
  let pos = 0
  for (const [at, del, ins] of patch) {
    while (pos < at && pos < textLines.length) out.push(textLines[pos++]!)
    out.push(...ins)
    pos += del
  }
  while (pos < textLines.length) out.push(textLines[pos++]!)

  return out
}

/** FNV-1a over UTF-16 units: a cheap fingerprint to tell whether two texts differ. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }

  return `${(h >>> 0).toString(16)}:${text.length}`
}
