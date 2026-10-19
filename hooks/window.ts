// What the editor of a file too large to hand over whole holds. Pure: no `$`, no state.
// Such a file goes as its hunks: the changes with CONTEXT lines around them,
// as many as WINDOW_CHARS holds, the unchanged stretches between them left
// out until a click brings them in. "Whole file" goes by contiguous parts.

import type { FileWindow, Piece } from '../types'
import { changeBlocks, diffLines, fingerprint, hunksOf, makePatch, splitLines } from './diff'
import type { Row } from './diff'

/** What the rows of one window may come to, text and base together. */
export const WINDOW_CHARS = 40_000
/** As far as a change block may take a window past WINDOW_CHARS, so as not to be cut in two. */
const BLOCK_CHARS = 2 * WINDOW_CHARS
/** How many rows a contiguous part keeps before the change it is cut for. */
const LEAD = 20
/** How many rows the next or previous contiguous part shares with the one before. */
const OVERLAP = 10
/** How many lines a click on a stretch left out brings in from each side, when the whole stretch does not fit. */
const EXPAND = 20

/** Whether a text and the patch to its base are past `max` characters as props. */
export const isTooLarge = (base: string, text: string, max: number) =>
  JSON.stringify([text, makePatch(base, text)]).length > max

const rowsOf = (base: string, text: string) => diffLines(splitLines(base), splitLines(text))

const cost = (rows: readonly Row[], k: number) => rows[k]!.text.length + 8

/** Text and base lines before each row. */
function linesBefore(rows: readonly Row[]): { text: Int32Array; base: Int32Array } {
  const text = new Int32Array(rows.length + 1)
  const base = new Int32Array(rows.length + 1)
  rows.forEach((row, k) => {
    text[k + 1] = text[k]! + (row.kind !== 'del' ? 1 : 0)
    base[k + 1] = base[k]! + (row.kind !== 'add' ? 1 : 0)
  })

  return { text, base }
}

/** Rows [r0, r1) as a piece. */
function pieceOf(rows: readonly Row[], r0: number, r1: number, at = linesBefore(rows)): Piece {
  return {
    line: at.text[r0]!,
    lines: at.text[r1]! - at.text[r0]!,
    baseLine: at.base[r0]!,
    baseLines: at.base[r1]! - at.base[r0]!,
  }
}

/** Rows [r0, r1) of the piece `p`. */
function rowsAt(rows: readonly Row[], p: Piece): [number, number] {
  const at = linesBefore(rows)
  let r0 = 0
  while (r0 < rows.length && (at.text[r0]! < p.line || at.base[r0]! < p.baseLine)) r0++
  let r1 = r0
  while (r1 < rows.length && (at.text[r1]! < p.line + p.lines || at.base[r1]! < p.baseLine + p.baseLines)) r1++

  return [r0, r1]
}

/**
 * A contiguous part from row `at` on (or, `dir` -1, ending at it), as many
 * rows as WINDOW_CHARS holds, filled out the other way at an end of the
 * file, and with at least one line of text to edit.
 */
function cut(rows: readonly Row[], at: number, dir: 1 | -1): [number, number] {
  let r0 = Math.max(0, Math.min(rows.length, at))
  let r1 = r0
  let size = 0
  const forward = () => {
    while (r1 < rows.length && (r1 === r0 || size + cost(rows, r1) <= WINDOW_CHARS)) size += cost(rows, r1++)
  }
  const backward = () => {
    while (r0 > 0 && (r0 === r1 || size + cost(rows, r0 - 1) <= WINDOW_CHARS)) size += cost(rows, --r0)
  }
  if (dir > 0) {
    forward()
    backward()
  } else {
    backward()
    forward()
  }
  // A change block is not cut in two, unless it is too long for any window.
  const isChange = (k: number) => rows[k] !== undefined && rows[k]!.kind !== 'ctx'
  while (isChange(r1 - 1) && isChange(r1) && size + cost(rows, r1) <= BLOCK_CHARS) size += cost(rows, r1++)
  while (isChange(r0) && isChange(r0 - 1) && size + cost(rows, r0 - 1) <= BLOCK_CHARS) size += cost(rows, --r0)
  while (r1 < rows.length && pieceOf(rows, r0, r1).lines === 0) r1++

  return [r0, r1]
}

/**
 * Whole hunks from row `from` on (`dir` 1), or back from it, as many as
 * WINDOW_CHARS holds; the first one even past it, up to BLOCK_CHARS. Only a
 * hunk too long for that is cut short, and the next window goes on from
 * there. Empty when no hunk lies that way.
 */
function group(rows: readonly Row[], from: number, dir: 1 | -1): [number, number][] {
  const ranges: [number, number][] = []
  const costOf = (a: number, b: number) => {
    let sum = 0
    for (let k = a; k < b; k++) sum += cost(rows, k)
    return sum
  }
  let size = 0
  const hunks = hunksOf(rows)
    .map(([s, e]): [number, number] => (dir > 0 ? [Math.max(s, from), e] : [s, Math.min(e, from)]))
    .filter(([s, e]) => s < e)
  for (const [s, e] of dir > 0 ? hunks : hunks.reverse()) {
    const c = costOf(s, e)
    if (ranges.length > 0 && size + c > WINDOW_CHARS) break
    if (c <= BLOCK_CHARS) {
      size += c
      if (dir > 0) ranges.push([s, e])
      else ranges.unshift([s, e])
      continue
    }
    // Too long for any window: as much of it as fits, from the end the window comes from.
    let k = dir > 0 ? s : e
    for (let sum = 0; dir > 0 ? k < e : k > s; ) {
      const step = cost(rows, dir > 0 ? k : k - 1)
      if (sum + step > BLOCK_CHARS && sum > 0) break
      sum += step
      k += dir
    }
    if (dir > 0) ranges.push([s, k])
    else ranges.unshift([k, e])
    break
  }

  return ranges
}

/** A window of hunks over row ranges, with whether changes lie outside them. */
function windowOver(
  rows: readonly Row[],
  ranges: [number, number][],
  w: Pick<FileWindow, 'rev' | 'baseKey' | 'seq'>,
): FileWindow {
  const first = ranges[0]![0]
  const last = ranges[ranges.length - 1]![1]
  const at = linesBefore(rows)

  return {
    pieces: ranges.map(([a, b]) => pieceOf(rows, a, b, at)),
    isWhole: false,
    before: rows.slice(0, first).some(r => r.kind !== 'ctx'),
    after: rows.slice(last).some(r => r.kind !== 'ctx'),
    ...w,
  }
}

/** A contiguous part over rows [r0, r1). */
function wholeOver(rows: readonly Row[], [r0, r1]: [number, number], w: Pick<FileWindow, 'rev' | 'baseKey' | 'seq'>) {
  return { pieces: [pieceOf(rows, r0, r1)], isWhole: true, before: r0 > 0, after: r1 < rows.length, ...w }
}

function fits(base: string, text: string, w: FileWindow): boolean {
  const lines = splitLines(text).length
  const baseLines = splitLines(base).length
  let line = 0
  let baseLine = 0
  for (const p of w.pieces) {
    if (p.line < line || p.baseLine < baseLine) return false
    line = p.line + p.lines
    baseLine = p.baseLine + p.baseLines
  }

  return w.pieces.length > 0 && line <= lines && baseLine <= baseLines
}

/**
 * The window to show: `kept` while it was cut for this rev and base and the
 * same view, else one cut afresh where it was, or from the first change.
 */
export function windowFor(
  base: string,
  text: string,
  rev: number,
  baseKey: string,
  isWhole: boolean,
  kept?: FileWindow,
): FileWindow {
  if (kept && kept.rev === rev && kept.baseKey === baseKey && kept.isWhole === isWhole && fits(base, text, kept)) {
    return kept
  }
  const rows = rowsOf(base, text)
  const head = { rev, baseKey, seq: (kept?.seq ?? 0) + 1 }
  // Where the window was, unless the view changed between hunks and the whole file.
  const was = kept && kept.isWhole === isWhole ? rows.findIndex(r => r.newNo === kept.pieces[0]!.line + 1) : -1
  if (isWhole) {
    const at = was >= 0 ? was : Math.max(0, rows.findIndex(r => r.kind !== 'ctx') - LEAD)

    return wholeOver(rows, cut(rows, at, 1), head)
  }
  const ranges = group(rows, Math.max(0, was), 1)
  if (ranges.length === 0 && was > 0) ranges.push(...group(rows, 0, 1))
  // No change at all: the file's start, to show it has none.
  if (ranges.length === 0) ranges.push(cut(rows, 0, 1))

  return windowOver(rows, ranges, head)
}

/** The hunks past the window (`dir` 1) or before it; undefined when there are none. */
export function windowAtChange(base: string, text: string, w: FileWindow, dir: 1 | -1): FileWindow | undefined {
  const rows = rowsOf(base, text)
  const head = { rev: w.rev, baseKey: w.baseKey, seq: w.seq + 1 }
  const first = rowsAt(rows, w.pieces[0]!)[0]
  const last = rowsAt(rows, w.pieces[w.pieces.length - 1]!)[1]
  if (w.isWhole) {
    const blocks = changeBlocks(rows)
    const block = dir > 0 ? blocks.find(([s]) => s >= last) : blocks.filter(([, e]) => e <= first).pop()
    if (!block) return undefined

    return wholeOver(rows, dir > 0 ? cut(rows, block[0] - LEAD, 1) : cut(rows, block[1] + LEAD, -1), head)
  }
  const ranges = group(rows, dir > 0 ? last : first, dir)

  return ranges.length > 0 ? windowOver(rows, ranges, head) : undefined
}

/** The next part of the file (`dir` 1) or the previous one; undefined at that end. */
export function shiftWindow(base: string, text: string, w: FileWindow, dir: 1 | -1): FileWindow | undefined {
  if (!w.isWhole) return windowAtChange(base, text, w, dir)
  const rows = rowsOf(base, text)
  const [r0, r1] = rowsAt(rows, w.pieces[0]!)
  if (dir > 0 ? r1 >= rows.length : r0 <= 0) return undefined
  const span = dir > 0 ? cut(rows, Math.max(r0 + 1, r1 - OVERLAP), 1) : cut(rows, Math.min(r1 - 1, r0 + OVERLAP), -1)

  return wholeOver(rows, span, { rev: w.rev, baseKey: w.baseKey, seq: w.seq + 1 })
}

/** The key of the editor holding `w`: a new instance for each cut and base. */
export const windowKey = (id: number, w: FileWindow) => `file-${id}~${w.seq}~${fingerprint(w.baseKey).split(':')[0]}`

/** The window's text and base, as the editor is handed them: its pieces end to end. */
export function slices(base: string, text: string, w: FileWindow): { text: string; base: string } {
  const all = splitLines(text)
  const allBase = splitLines(base)

  return {
    text: w.pieces.flatMap(p => all.slice(p.line, p.line + p.lines)).join('\n'),
    base: w.pieces.flatMap(p => allBase.slice(p.baseLine, p.baseLine + p.baseLines)).join('\n'),
  }
}

/**
 * What the editor is told of the stretches left out: those between pieces,
 * as [where in its base they fall, how many lines]; and how many lines before
 * the first piece and after the last a click may bring in.
 */
export function gapsOf(base: string, w: FileWindow): { gaps: [number, number][]; lead: number; trail: number } {
  const ps = w.pieces
  const gaps: [number, number][] = []
  let at = 0
  for (let k = 1; k < ps.length; k++) {
    at += ps[k - 1]!.baseLines
    gaps.push([at, ps[k]!.baseLine - ps[k - 1]!.baseLine - ps[k - 1]!.baseLines])
  }
  const last = ps[ps.length - 1]!
  const isOpen = !w.isWhole

  return {
    gaps,
    lead: isOpen && !w.before ? ps[0]!.baseLine : 0,
    trail: isOpen && !w.after ? splitLines(base).length - last.baseLine - last.baseLines : 0,
  }
}

/**
 * The whole text with the editor's text, `part`, back in place of the
 * pieces, and the pieces as they now fall. `cuts` are where the stretches
 * between pieces fall in `part`. The editor ends every line of a CRLF part
 * with CRLF but the last: inside the file that one keeps its CR too.
 */
export function spliceBack(
  text: string,
  w: FileWindow,
  part: string,
  cuts: readonly number[],
): { text: string; window: FileWindow } {
  const all = splitLines(text)
  const lines = splitLines(part)
  const ps = w.pieces
  const isCut = cuts.length === ps.length - 1 && cuts.every((c, k) => c >= (cuts[k - 1] ?? 0) && c <= lines.length)
  // Without cuts from the editor, the pieces keep their sizes and the last takes the rest.
  let sum = 0
  const at = isCut ? cuts : ps.slice(0, -1).map(p => Math.min(lines.length, (sum += p.lines)))
  const bounds = [0, ...at, lines.length]
  const last = ps[ps.length - 1]!
  const isLast = last.line + last.lines >= all.length
  const isCRLF = ps.some(p => all.slice(p.line, p.line + p.lines).some(line => line.endsWith('\r')))
  const out = all.slice(0, ps[0]!.line)
  const pieces = ps.map((p, k) => {
    const line = out.length
    out.push(...lines.slice(bounds[k], bounds[k + 1]))
    if (k + 1 < ps.length) out.push(...all.slice(p.line + p.lines, ps[k + 1]!.line))

    return { ...p, line, lines: bounds[k + 1]! - bounds[k]! }
  })
  if (isCRLF && !isLast && out.length > 0) out[out.length - 1] = out[out.length - 1]!.replace(/\r?$/, '\r')
  out.push(...all.slice(last.line + last.lines))

  return { text: out.join('\n'), window: { ...w, pieces } }
}

/**
 * The window with a stretch left out brought in: `at` 0 the one before the
 * first piece, k the one before piece k, the piece count the one after the
 * last. The whole stretch if it fits under `max`, else EXPAND lines from each
 * side; undefined when not even those fit, or there is no such stretch.
 */
export function expandGap(base: string, text: string, w: FileWindow, at: number, max: number): FileWindow | undefined {
  const n = w.pieces.length
  const total = splitLines(text).length
  const { lead, trail } = gapsOf(base, w)
  if (at < 0 || at > n || (at === 0 && lead === 0) || (at === n && trail === 0)) return undefined
  const grow = (p: Piece, before: number, after: number): Piece => ({
    line: p.line - before,
    lines: p.lines + before + after,
    baseLine: p.baseLine - before,
    baseLines: p.baseLines + before + after,
  })
  const attempt = (isAll: boolean): FileWindow => {
    const ps = w.pieces.slice()
    if (at === 0) ps[0] = grow(ps[0]!, isAll ? lead : Math.min(lead, EXPAND), 0)
    else if (at === n) ps[n - 1] = grow(ps[n - 1]!, 0, isAll ? trail : Math.min(trail, EXPAND))
    else {
      const a = ps[at - 1]!
      const b = ps[at]!
      const gap = b.line - a.line - a.lines
      const merged = {
        line: a.line,
        lines: b.line + b.lines - a.line,
        baseLine: a.baseLine,
        baseLines: b.baseLine + b.baseLines - a.baseLine,
      }
      if (isAll || gap <= 2 * EXPAND) ps.splice(at - 1, 2, merged)
      else ps.splice(at - 1, 2, grow(a, 0, EXPAND), grow(b, EXPAND, 0))
    }

    return { ...w, pieces: ps, seq: w.seq + 1 }
  }
  for (const isAll of [true, false]) {
    const next = attempt(isAll)
    const s = slices(base, text, next)
    if (next.pieces.every(p => p.line >= 0 && p.line + p.lines <= total) && !isTooLarge(s.base, s.text, max)) {
      return next
    }
  }

  return undefined
}
