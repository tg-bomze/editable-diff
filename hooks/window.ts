// Parts of a file too large to hand to an editor whole. Pure: no `$`, no state.

import type { FileWindow } from '../types'
import { changeBlocks, diffLines, fingerprint, makePatch, splitLines } from './diff'
import type { Row } from './diff'

/** What the rows of one window may come to, text and base together. */
export const WINDOW_CHARS = 40_000
/** How many rows a window keeps before the change it is cut for. */
const LEAD = 20
/** How many rows the next or previous part shares with the one before. */
const OVERLAP = 10

/** Where a window is, without the rev and base it was cut for. */
type Span = Omit<FileWindow, 'rev' | 'baseKey'>

/** Whether a text and the patch to its base are past `max` characters as props. */
export const isTooLarge = (base: string, text: string, max: number) =>
  JSON.stringify([text, makePatch(base, text)]).length > max

const rowsOf = (base: string, text: string) => diffLines(splitLines(base), splitLines(text))

function spanOf(rows: readonly Row[], r0: number, r1: number): Span {
  const count = (from: number, to: number, kind: Row['kind']) => {
    let n = 0
    for (let k = from; k < to; k++) if (rows[k]!.kind !== kind) n++
    return n
  }

  return {
    line: count(0, r0, 'del'),
    lines: count(r0, r1, 'del'),
    baseLine: count(0, r0, 'add'),
    baseLines: count(r0, r1, 'add'),
  }
}

/** Rows [r0, r1) of the window `w`. */
function rowsAt(rows: readonly Row[], w: Span): [number, number] {
  let line = 0
  let baseLine = 0
  let r0 = rows.length
  let r1 = rows.length
  for (let k = 0; k <= rows.length; k++) {
    if (r0 === rows.length && line === w.line && baseLine === w.baseLine) r0 = k
    if (line === w.line + w.lines && baseLine === w.baseLine + w.baseLines) {
      r1 = k
      break
    }
    if (k === rows.length) break
    if (rows[k]!.kind !== 'del') line++
    if (rows[k]!.kind !== 'add') baseLine++
  }

  return [Math.min(r0, r1), r1]
}

/**
 * A window of rows from row `at` on (or, `dir` -1, ending at it), as many as
 * WINDOW_CHARS holds, filled out the other way at an end of the file, and
 * with at least one line of text to edit.
 */
function cut(rows: readonly Row[], at: number, dir: 1 | -1): Span {
  const cost = (k: number) => rows[k]!.text.length + 8
  let r0 = Math.max(0, Math.min(rows.length, at))
  let r1 = r0
  let size = 0
  const forward = () => {
    while (r1 < rows.length && (r1 === r0 || size + cost(r1) <= WINDOW_CHARS)) size += cost(r1++)
  }
  const backward = () => {
    while (r0 > 0 && (r0 === r1 || size + cost(r0 - 1) <= WINDOW_CHARS)) size += cost(--r0)
  }
  if (dir > 0) {
    forward()
    backward()
  } else {
    backward()
    forward()
  }
  while (r1 < rows.length && spanOf(rows, r0, r1).lines === 0) r1++

  return spanOf(rows, r0, r1)
}

const fits = (base: string, text: string, w: Span) =>
  w.line + w.lines <= splitLines(text).length && w.baseLine + w.baseLines <= splitLines(base).length && w.lines > 0

/** The window to show: `kept` while it was cut for this rev and base, else one cut afresh where it was, or at the first change. */
export function windowFor(base: string, text: string, rev: number, baseKey: string, kept?: FileWindow): FileWindow {
  if (kept && kept.rev === rev && kept.baseKey === baseKey && fits(base, text, kept)) return kept
  const rows = rowsOf(base, text)
  const was = kept ? rows.findIndex(r => r.newNo === kept.line + 1) : -1
  const at = was >= 0 ? was : Math.max(0, rows.findIndex(r => r.kind !== 'ctx') - LEAD)

  return { ...cut(rows, at, 1), rev, baseKey }
}

/** The next part of the file (`dir` 1) or the previous one, sharing OVERLAP rows; undefined at that end. */
export function shiftWindow(base: string, text: string, w: FileWindow, dir: 1 | -1): FileWindow | undefined {
  const rows = rowsOf(base, text)
  const [r0, r1] = rowsAt(rows, w)
  if (dir > 0 ? r1 >= rows.length : r0 <= 0) return undefined
  const span = dir > 0 ? cut(rows, Math.max(r0 + 1, r1 - OVERLAP), 1) : cut(rows, Math.min(r1 - 1, r0 + OVERLAP), -1)

  return { ...span, rev: w.rev, baseKey: w.baseKey }
}

/** The window around the next change past `w` (`dir` 1) or the last one before it; undefined when there is none. */
export function windowAtChange(base: string, text: string, w: FileWindow, dir: 1 | -1): FileWindow | undefined {
  const rows = rowsOf(base, text)
  const [r0, r1] = rowsAt(rows, w)
  const blocks = changeBlocks(rows)
  const block = dir > 0 ? blocks.find(([s]) => s >= r1) : blocks.filter(([, e]) => e <= r0).pop()
  if (!block) return undefined
  const span = dir > 0 ? cut(rows, block[0] - LEAD, 1) : cut(rows, block[1] + LEAD, -1)

  return { ...span, rev: w.rev, baseKey: w.baseKey }
}

/** The key of the editor holding `w`: a new instance for each part and base. */
export const windowKey = (id: number, w: FileWindow) => `file-${id}~${w.line}~${fingerprint(w.baseKey).split(':')[0]}`

/** The window's text and base, as the editor is handed them. */
export function slices(base: string, text: string, w: Span): { text: string; base: string } {
  return {
    text: splitLines(text)
      .slice(w.line, w.line + w.lines)
      .join('\n'),
    base: splitLines(base)
      .slice(w.baseLine, w.baseLine + w.baseLines)
      .join('\n'),
  }
}

/**
 * The whole text with the window's lines replaced by `part`, the editor's
 * text, and how many lines the window holds now. The editor ends every line
 * of a CRLF part with CRLF but the last: inside the file that one keeps its
 * CR too.
 */
export function spliceBack(text: string, w: Span, part: string): { text: string; lines: number } {
  const all = splitLines(text)
  const isLast = w.line + w.lines >= all.length
  const isCRLF = all.slice(w.line, w.line + w.lines).some(line => line.endsWith('\r'))
  const lines = splitLines(part)
  if (isCRLF && !isLast) lines[lines.length - 1] = lines[lines.length - 1]!.replace(/\r?$/, '\r')
  all.splice(w.line, w.lines, ...lines)

  return { text: all.join('\n'), lines: lines.length }
}
