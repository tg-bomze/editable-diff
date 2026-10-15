// Line diff shared by the hooks module and the editor. Pure: no `$`, no state.

export type RowKind = 'ctx' | 'add' | 'del'

/** One row of a unified diff. `oldNo`/`newNo` are 1-based, 0 where absent. */
export type Row = { kind: RowKind; text: string; oldNo: number; newNo: number }

/** Lines of text vs base, one patch hunk: at text line `at`, `del` text lines stand for the base lines `ins`. */
export type Patch = [at: number, del: number, ins: string[]][]

export const CONTEXT = 5

/** Past this many cells the middle is shown as all removed then all added. */
const MAX_CELLS = 2_000_000

export function splitLines(text: string): string[] {
  return text.split('\n')
}

export function diffLines(a: readonly string[], b: readonly string[]): Row[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const rows: Row[] = []
  for (let i = 0; i < start; i++) rows.push({ kind: 'ctx', text: b[i]!, oldNo: i + 1, newNo: i + 1 })

  const n = endA - start
  const m = endB - start
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_CELLS) {
    // LCS lengths of the suffixes, row-major over (n + 1) x (m + 1).
    const w = m + 1
    const t = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] =
          a[start + i] === b[start + j]
            ? t[(i + 1) * w + j + 1]! + 1
            : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        rows.push({ kind: 'ctx', text: b[start + j]!, oldNo: start + i + 1, newNo: start + j + 1 })
        i++
        j++
      } else if (j < m && (i === n || t[i * w + j + 1]! >= t[(i + 1) * w + j]!)) {
        rows.push({ kind: 'add', text: b[start + j]!, oldNo: 0, newNo: start + j + 1 })
        j++
      } else {
        rows.push({ kind: 'del', text: a[start + i]!, oldNo: start + i + 1, newNo: 0 })
        i++
      }
    }
    // Within a change, show the removed lines above the added ones.
    return [...rows.slice(0, start), ...groupChanges(rows.slice(start)), ...suffix(a, b, endA, endB)]
  }

  for (let i = start; i < endA; i++) rows.push({ kind: 'del', text: a[i]!, oldNo: i + 1, newNo: 0 })
  for (let j = start; j < endB; j++) rows.push({ kind: 'add', text: b[j]!, oldNo: 0, newNo: j + 1 })

  return [...rows, ...suffix(a, b, endA, endB)]
}

function suffix(a: readonly string[], b: readonly string[], endA: number, endB: number): Row[] {
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
