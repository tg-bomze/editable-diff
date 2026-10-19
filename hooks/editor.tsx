// The editor: one file's diff against a base text, drawn the way GitHub
// Desktop draws one (old and new line numbers, hunk headers, syntax colours,
// unified or split) and edited in place.
// Runs on the drawing thread; reaches the hooks module only by `surface.post`.
//
// Everything is drawn in the monospaced face, so a cell of the region is one
// column of text and the pointer lands where it is drawn. Long lines wrap to
// the region's width. Every hunk is drawn, as GitHub draws them; only a diff
// past what one drawing may hold is cut after a whole change block, and
// scrolls down and up by half a drawing. A file too large to hand over whole comes as its
// hunks, pieces of it end to end: the stretches between them are drawn as left
// out, and a click on one asks the hooks module for its lines.

import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface, Color } from 'claude-code'

import type { EditorCommand, EditorPost } from '../types'
import {
  applyPatch,
  changeBlocks,
  countChanges,
  hunksOf,
  diffLines,
  fingerprint,
  isHiddenChar,
  isWordChar,
  splitLines,
  visibleRows,
  wordRanges,
} from './diff'
import type { Patch, Row } from './diff'
import { lineStates, tokenize } from './highlight'
import type { LineState, TokenKind } from './highlight'

export type EditorProps = {
  /** Absolute path: what a post names. */
  file: string
  /** The text to edit: the unsaved draft, else the file on disk. */
  text: string
  /** Turns `text` into the base the diff is drawn against. */
  patch: Patch
  /** Bumped when the editor must take `text` afresh. */
  rev: number
  /** Changes when the diff is drawn against another base: the editor takes it from `patch` afresh. */
  baseKey: string
  /** Fingerprint of the file on disk, to tell whether the editor holds unsaved edits. */
  diskHash: string
  /** The file changed on disk under unsaved edits: keep the edits until the person decides. */
  conflict: boolean
  /** Show the whole file, not only the changes. */
  expanded: boolean
  /** Old and new side by side, where the region is wide enough. */
  isSplit: boolean
  ignoreWhitespace: boolean
  /** The file shown in the pane: only it draws a cursor. */
  isFocused: boolean
  /** The surface drawing it: the terminal gets theme colours and a block cursor. */
  surface: string
  /** The highlighter's language, or null to draw plain. */
  language: string | null
  isDark: boolean
  /** Line ranges with a review comment, 1-based, inclusive. */
  notes: [number, number][]
  /** The last thing a pane button asked; acted on once per `seq`. */
  command: EditorCommand | null
  /** What the drawn rows may serialize to. */
  budget: number
  /** Where `text` starts in the file, 0-based, when it is a part of a file too large to hand over whole. */
  firstLine: number
  /** Where the base `patch` gives starts in the base. */
  firstBaseLine: number
  /** By pieces: the stretches left out between them, as [base line index here they fall before, lines]. */
  gaps: [number, number][]
  /** Lines left out before the first piece and after the last that a click may bring in. */
  lead: number
  trail: number
  /** The text is the file's hunks, pieces end to end: every row of it is shown. */
  isPieces: boolean
}

type Pos = { row: number; col: number }

/** A wrapped piece of a diff row: code units [from, to) of row `k`. */
type Seg = { k: number; from: number; to: number; first: boolean; last: boolean }

/** One row of the region. A line's `seg` is the side that is edited; `left` the old side when split. */
type Item =
  | { kind: 'line'; v: number; seg?: Seg; left?: Seg; block?: [number, number] }
  /** Rows [from, to) hidden; with `far`, also `hidden` lines left out of the text, asked for by a click. */
  | { kind: 'gap'; from: number; to: number; header: string; far?: number; hidden?: number }
  /** `count` hunks before the drawing or after where the budget stopped it, among `lines` units in all. */
  | { kind: 'prev' | 'next'; count: number; lines: number }

/** What the window moves over: a diff row, or an old and a new row side by side. */
type Unit = { l?: number; r?: number }

type Snap = { lines: string[]; cur: Pos; anchor: Pos | null }

type Find = { query: string; replace: string; field: 'find' | 'replace'; isTyping: boolean }
type Match = { row: number; from: number; to: number }

type Model = {
  instance: string
  surface: ClientSurface<State>
  props: EditorProps
  rev: number
  baseKey: string
  eol: string
  base: string[]
  baseStates: LineState[]
  lines: string[]
  cur: Pos
  anchor: Pos | null
  /** The cell column up and down aim for. */
  goalX: number | null
  isActive: boolean
  isBlinkOn: boolean
  version: number
  diff?: {
    version: number
    ignoreWhitespace: boolean
    rows: Row[]
    words: Map<number, [number, number]>
    states: LineState[]
    blocks: [number, number][]
    blockEnd: Map<number, number>
    /** The file's 0-based line of each line here, and of each base line. */
    newAt: Int32Array
    oldAt: Int32Array
    /** Rows that start after a stretch left out, to the stretch's number (k, before piece k). */
    far: Map<number, number>
    /** Where each stretch between pieces falls in the text, as a line index. */
    cuts: number[]
  }
  /** Base line numbers of unchanged lines the person opened. */
  opened: Set<number>
  /** The window's first unit. */
  win: number
  /** The first unit the last drawing left out: the window's end, or sooner when it ran past the budget. */
  stop: number
  /** How many units there are in all, for the window's last one. */
  shown: number
  /** The unit each hunk starts at. */
  hs: number[]
  /** The unit at half of what the last drawing serialized to: where moving on starts the next one. */
  midAt: number
  /** The units of the last layout, which `win`, `stop` and `hs` count in. */
  units: Unit[]
  /** Keep the cursor inside the window (after keys); off once the person moves the window. */
  isFollowing: boolean
  undo: Snap[]
  redo: Snap[]
  lastEdit: { kind: string; at: number; row: number }
  saveSeq: number
  copySeq: number
  focusSeq: number
  commentSeq: number
  edgeSeq: number
  revealSeq: number
  expandSeq: number
  /** The stretch left out the last click asked for. */
  expand: number
  edge: 1 | -1
  cmdSeq: number
  clip: string
  /** The lines last posted as the selection. */
  sentSel: string
  indent: string
  find: Find | null
  matches?: { version: number; query: string; list: Match[] }
  /** Click targets of the find bar, by cell column. */
  hits: { from: number; to: number; act: () => void }[]
  /** What the last layout put on each row of the region below the find bar, for the pointer. */
  items: Item[]
  /** Rows above the items: the find bar. */
  top: number
  numW: number
  /** Where the edited text starts, in cells from the region's left edge. */
  textX: number
  isSplitDrawn: boolean
  /** Cells of each side's text column (marker included) when split. */
  half: number
  isDragging: boolean
  lastClick: { at: number; row: number; col: number; count: number }
}

type State = { m: Model }

const TAB = 4
const UNDO = 300
const BUDGET = 80_000
/**
 * How far past the budget a change block may take the drawing so as not to
 * be cut in two: within the tree's bounds (100,000 characters serialized), and
 * shrinking with the budget when a surface cannot draw that much.
 */
const BLOCK_ROOM = 1.15
const MAX_MATCHES = 5000
/** The narrowest text column a split side may have. */
const MIN_SPLIT = 24
const REVERT = ' ↺ Revert '
const SPECIAL = new Set(
  'up down left right home end pageup pagedown return enter backspace delete tab space escape insert clear f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 f11 f12'.split(
    ' ',
  ),
)

type Palette = {
  addLine: Color
  delLine: Color
  addGutter: Color
  delGutter: Color
  addWord: Color
  delWord: Color
  find: Color
  hunk?: Color
  selection?: Color
  blank?: Color
  syntax: Record<TokenKind, Color>
}

const DARK_SYNTAX: Record<TokenKind, Color> = {
  comment: '#8b949e',
  string: '#a5d6ff',
  number: '#79c0ff',
  keyword: '#ff7b72',
  type: '#ffa657',
  function: '#d2a8ff',
  constant: '#79c0ff',
  key: '#7ee787',
  heading: '#79c0ff',
}
const LIGHT_SYNTAX: Record<TokenKind, Color> = {
  comment: '#6e7781',
  string: '#0a3069',
  number: '#0550ae',
  keyword: '#cf222e',
  type: '#953800',
  function: '#8250df',
  constant: '#0550ae',
  key: '#116329',
  heading: '#0550ae',
}

/** Translucent tints, so they read on a light and a dark page alike. */
const APP = {
  addLine: '#2ea04326',
  delLine: '#f8514926',
  addGutter: '#2ea04340',
  delGutter: '#f8514940',
  addWord: '#2ea04370',
  delWord: '#f8514970',
  find: '#d2992666',
  hunk: '#388bfd1f',
  selection: '#388bfd59',
  blank: '#8b949e14',
}
const TERMINAL = {
  addLine: 'diffAddedDimmed',
  delLine: 'diffRemovedDimmed',
  addGutter: 'diffAddedDimmed',
  delGutter: 'diffRemovedDimmed',
  addWord: 'diffAddedWord',
  delWord: 'diffRemovedWord',
  find: 'warning',
}

const now = () => {
  try {
    return Date.now()
  } catch {
    return 0
  }
}

const stripCR = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line)
const before = (a: Pos, b: Pos) => a.row < b.row || (a.row === b.row && a.col < b.col)
const same = (a: Pos, b: Pos) => a.row === b.row && a.col === b.col

function cellWidth(code: number): number {
  if (code >= 0x300 && code <= 0x36f) return 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2
  }

  return 1
}

/** A line as drawn: `glyph[i]` is what code unit i draws, `x[i]` the cell it starts at. */
function measure(line: string): { glyph: string[]; x: number[] } {
  const glyph: string[] = []
  const x: number[] = []
  let at = 0
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i)
    x.push(at)
    const next = i + 1 < line.length ? line.charCodeAt(i + 1) : 0
    if (c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      const code = line.codePointAt(i)!
      glyph.push(String.fromCodePoint(code))
      x.push(at)
      glyph.push('')
      at += cellWidth(code)
      i++
    } else if (c === 9) {
      const n = TAB - (at % TAB)
      glyph.push(' '.repeat(n))
      at += n
    } else if (c < 32 || c === 127) {
      glyph.push('·')
      at += 1
    } else if (isHiddenChar(c) || (c >= 0xd800 && c <= 0xdfff)) {
      // Shown, not hidden: a review must see what the text really holds.
      glyph.push('\ufffd')
      at += 1
    } else {
      glyph.push(line[i]!)
      at += cellWidth(c)
    }
  }
  x.push(at)

  return { glyph, x }
}

/** Where a line wraps at `width` cells (`firstWidth` for its first piece): piece starts, in code units. */
function wrapAt(x: number[], width: number, firstWidth = width): number[] {
  const starts = [0]
  if (!Number.isFinite(width) || width < 1) return starts
  const first = Math.max(1, firstWidth)
  let s = 0
  for (let i = 0; i < x.length - 1; i++) {
    if (x[i + 1]! - x[s]! > (starts.length === 1 ? first : width) && i > s) {
      starts.push(i)
      s = i
    }
  }

  return starts
}

function load(m: Model, props: EditorProps): void {
  const raw = splitLines(props.text)
  m.eol = props.text.includes('\r\n') ? '\r\n' : '\n'
  m.lines = raw.map(stripCR)
  m.rev = props.rev
  m.cur = clamp(m, m.cur)
  m.anchor = null
  m.indent = m.lines.some(line => line.startsWith('\t')) ? '\t' : '    '
  rebase(m, props)
}

/** Takes the base from the props: the patch turns their text into it. */
function rebase(m: Model, props: EditorProps): void {
  m.base = applyPatch(splitLines(props.text), props.patch).map(stripCR)
  m.baseStates = lineStates(m.base, props.language ?? undefined)
  m.baseKey = props.baseKey
  m.version++
}

function clamp(m: Model, p: Pos): Pos {
  const row = Math.max(0, Math.min(m.lines.length - 1, p.row))

  return { row, col: Math.max(0, Math.min(m.lines[row]!.length, p.col)) }
}

const textOf = (m: Model) => m.lines.join(m.eol)

function diffOf(m: Model): NonNullable<Model['diff']> {
  const ignoreWhitespace = m.props.ignoreWhitespace
  if (!m.diff || m.diff.version !== m.version || m.diff.ignoreWhitespace !== ignoreWhitespace) {
    const rows = diffLines(m.base, m.lines, { ignoreWhitespace })
    const blocks = changeBlocks(rows)
    m.diff = {
      version: m.version,
      ignoreWhitespace,
      rows,
      words: wordRanges(rows),
      states: lineStates(m.lines, m.props.language ?? undefined),
      blocks,
      blockEnd: new Map(blocks),
      ...placesOf(m, rows),
    }
  }

  return m.diff
}

/**
 * Where the lines here are in the file: past each stretch left out between
 * pieces, the lines after it are that many further on. A stretch falls before
 * the first row of the base line it was left out before.
 */
function placesOf(
  m: Model,
  rows: readonly Row[],
): Pick<NonNullable<Model['diff']>, 'newAt' | 'oldAt' | 'far' | 'cuts'> {
  const { gaps, firstLine, firstBaseLine } = m.props
  const newAt = new Int32Array(m.lines.length)
  const oldAt = new Int32Array(m.base.length)
  const far = new Map<number, number>()
  const cuts: number[] = []
  let off = 0
  let n = 0
  let texts = 0
  rows.forEach((row, k) => {
    if (row.oldNo > 0) {
      while (n < gaps.length && gaps[n]![0] <= row.oldNo - 1) {
        off += gaps[n]![1]
        far.set(k, ++n)
        cuts.push(texts)
      }
      oldAt[row.oldNo - 1] = row.oldNo - 1 + firstBaseLine + off
    }
    if (row.newNo > 0) {
      newAt[row.newNo - 1] = row.newNo - 1 + firstLine + off
      texts++
    }
  })
  while (cuts.length < gaps.length) cuts.push(texts)

  return { newAt, oldAt, far, cuts }
}

function selection(m: Model): [Pos, Pos] | null {
  if (!m.anchor || same(m.anchor, m.cur)) return null

  return before(m.anchor, m.cur) ? [m.anchor, m.cur] : [m.cur, m.anchor]
}

/** The lines the selection covers, or the cursor's line: 1-based, inclusive. */
function selectedLines(m: Model): [number, number] {
  const sel = selection(m)
  const { newAt } = diffOf(m)
  const at = (row: number) => newAt[row]! + 1
  if (!sel) return [at(m.cur.row), at(m.cur.row)]
  const last = sel[1].col === 0 && sel[1].row > sel[0].row ? sel[1].row - 1 : sel[1].row

  return [at(sel[0].row), at(last)]
}

function textBetween(m: Model, a: Pos, b: Pos): string {
  if (a.row === b.row) return m.lines[a.row]!.slice(a.col, b.col)
  const out = [m.lines[a.row]!.slice(a.col)]
  for (let r = a.row + 1; r < b.row; r++) out.push(m.lines[r]!)
  out.push(m.lines[b.row]!.slice(0, b.col))

  return out.join(m.eol)
}

function removeBetween(m: Model, a: Pos, b: Pos): void {
  const head = m.lines[a.row]!.slice(0, a.col)
  const tail = m.lines[b.row]!.slice(b.col)
  m.lines.splice(a.row, b.row - a.row + 1, head + tail)
  m.cur = { ...a }
  m.anchor = null
}

function insert(m: Model, s: string): void {
  const sel = selection(m)
  if (sel) removeBetween(m, sel[0], sel[1])
  m.anchor = null
  const parts = s.replace(/\r\n?/g, '\n').split('\n')
  const line = m.lines[m.cur.row]!
  const head = line.slice(0, m.cur.col)
  const tail = line.slice(m.cur.col)
  if (parts.length === 1) {
    m.lines[m.cur.row] = head + s + tail
    m.cur = { row: m.cur.row, col: m.cur.col + s.length }
    return
  }
  const last = parts[parts.length - 1]!
  m.lines.splice(m.cur.row, 1, head + parts[0]!, ...parts.slice(1, -1), last + tail)
  m.cur = { row: m.cur.row + parts.length - 1, col: last.length }
}

function snapshot(m: Model, kind: string): void {
  const t = now()
  const isRun =
    kind === 'type' && m.lastEdit.kind === 'type' && m.lastEdit.row === m.cur.row && t - m.lastEdit.at < 1500
  m.lastEdit = { kind, at: t, row: m.cur.row }
  if (isRun) return
  m.undo.push({ lines: m.lines.slice(), cur: { ...m.cur }, anchor: m.anchor && { ...m.anchor } })
  if (m.undo.length > UNDO) m.undo.shift()
  m.redo = []
}

function restore(m: Model, from: Snap[], to: Snap[]): boolean {
  const snap = from.pop()
  if (!snap) return false
  to.push({ lines: m.lines.slice(), cur: { ...m.cur }, anchor: m.anchor && { ...m.anchor } })
  m.lines = snap.lines
  m.cur = snap.cur
  m.anchor = snap.anchor
  m.lastEdit = { kind: '', at: 0, row: -1 }

  return true
}

function post(m: Model): void {
  const text = textOf(m)
  const sel = selectedLines(m)
  m.sentSel = sel.join('-')
  const data: EditorPost = {
    path: m.props.file,
    instance: m.instance,
    text,
    isDirty: fingerprint(text) !== m.props.diskHash,
    saveSeq: m.saveSeq,
    copySeq: m.copySeq,
    focusSeq: m.focusSeq,
    commentSeq: m.commentSeq,
    edgeSeq: m.edgeSeq,
    revealSeq: m.revealSeq,
    expandSeq: m.expandSeq,
    clip: m.clip,
    sel,
    edge: m.edge,
    cmdSeq: m.cmdSeq,
    cuts: diffOf(m).cuts,
    expand: m.expand,
  }
  m.surface.post(data)
}

/** Posts when the lines under the cursor changed, so the pane's buttons act on them. */
function postSelection(m: Model): void {
  if (selectedLines(m).join('-') !== m.sentSel) post(m)
}

function redraw(m: Model): void {
  m.surface.setState({ m })
}

/** "@@ -a,b +c,d @@" for the rows shown from row `start` up to the next gap. */
function hunkHeader(m: Model, rows: readonly Row[], shown: Uint8Array, start: number): string {
  let oldStart = 0
  let newStart = 0
  let oldCount = 0
  let newCount = 0
  const { far, newAt, oldAt } = diffOf(m)
  for (let k = start; k < rows.length && shown[k] && (k === start || !far.has(k)); k++) {
    const row = rows[k]!
    if (row.oldNo > 0) {
      if (!oldStart) oldStart = row.oldNo
      oldCount++
    }
    if (row.newNo > 0) {
      if (!newStart) newStart = row.newNo
      newCount++
    }
  }

  const old = oldStart ? oldAt[oldStart - 1]! + 1 : 0
  const now = newStart ? newAt[newStart - 1]! + 1 : 0

  return `@@ -${old},${oldCount} +${now},${newCount} @@`
}

/** The rows shown, side by side: unchanged rows face themselves, a change's removed rows its added ones. */
function pairUp(rows: readonly Row[], visible: readonly number[]): Unit[] {
  const out: Unit[] = []
  let n = 0
  while (n < visible.length) {
    const k = visible[n]!
    if (rows[k]!.kind === 'ctx') {
      out.push({ l: k, r: k })
      n++
      continue
    }
    const dels: number[] = []
    const adds: number[] = []
    do {
      ;(rows[visible[n]!]!.kind === 'del' ? dels : adds).push(visible[n]!)
      n++
    } while (n < visible.length && rows[visible[n]!]!.kind !== 'ctx' && visible[n]! === visible[n - 1]! + 1)
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ l: dels[i], r: adds[i] })
  }

  return out
}

const loOf = (u: Unit) => Math.min(u.l ?? Infinity, u.r ?? Infinity)
const hiOf = (u: Unit) => Math.max(u.l ?? -1, u.r ?? -1)

/** Lays out the region's rows: the window over the units shown, wrapped, with hunk headers between. */
function layout(m: Model): void {
  const { rows, blockEnd, far, newAt, oldAt } = diffOf(m)
  const pinned = new Set<number>()
  let cursorK = -1
  rows.forEach((row, k) => {
    if (row.newNo === m.cur.row + 1) cursorK = k
    if (row.kind === 'ctx' && m.opened.has(row.oldNo)) pinned.add(k)
  })
  if (m.isActive && cursorK >= 0) pinned.add(cursorK)
  const visible = m.props.expanded || m.props.isPieces ? rows.map((_, k) => k) : visibleRows(rows, pinned)

  m.numW = String(Math.max(1, newAt[m.lines.length - 1] ?? 0, oldAt[m.base.length - 1] ?? 0) + 1).length
  const columns = m.surface.columns
  const side = m.numW + 1
  const half = Math.floor((columns - 2 * side) / 2)
  m.isSplitDrawn = m.props.isSplit && half - 3 >= MIN_SPLIT
  let width: number
  let leftWidth = Infinity
  if (m.isSplitDrawn) {
    m.half = half
    m.textX = 2 * side + half + 3
    leftWidth = half - 3
    width = columns - m.textX
  } else {
    m.textX = m.numW * 2 + 5
    width = columns > m.textX + 8 ? columns - m.textX : Infinity
  }
  const units: Unit[] = m.isSplitDrawn ? pairUp(rows, visible) : visible.map(k => ({ r: k }))
  // The window keeps to its rows when the units shift: a line opened or the cursor's line pinned before it.
  if (m.units.length > 0) {
    const rowOf = (u: number) => (u < m.units.length ? loOf(m.units[u]!) : Infinity)
    const unitAt = (row: number) => {
      const k = units.findIndex(u => loOf(u) >= row)
      return k < 0 ? units.length : k
    }
    ;[m.win, m.stop] = [unitAt(rowOf(m.win)), unitAt(rowOf(m.stop))]
  }
  m.units = units

  // Hunks, by the unit each starts at: how many lie above and below a drawing too large to draw at once.
  m.hs = []
  let u0 = 0
  for (const [from] of hunksOf(rows, [...far.keys()])) {
    while (u0 < units.length && hiOf(units[u0]!) < from) u0++
    if (u0 < units.length && m.hs[m.hs.length - 1] !== u0) m.hs.push(u0)
  }

  if (m.isFollowing && cursorK >= 0) {
    const at = units.findIndex(u => u.r === cursorK)
    if (at >= 0 && (at < m.win || at >= m.stop)) {
      // From the start of the cursor's hunk, unless that is too far back to draw down to it.
      const start = m.hs[hunkAt(m.hs, at)]
      m.win = start !== undefined && at - start < 40 ? start : Math.max(0, at - 10)
    }
  }
  // Past the end (the diff got shorter), the drawing goes back to its last hunk.
  if (m.win >= units.length) m.win = m.hs[m.hs.length - 1] ?? 0
  m.win = Math.max(0, m.win)

  const segsOf = (k: number | undefined, w: number, firstW: number): Seg[] => {
    if (k === undefined) return []
    const text = rows[k]!.text
    const starts = wrapAt(measure(text).x, w, firstW)

    return starts.map((from, n) => ({
      k,
      from,
      to: n + 1 < starts.length ? starts[n + 1]! : text.length,
      first: n === 0,
      last: n === starts.length - 1,
    }))
  }

  const shown = new Uint8Array(rows.length)
  for (const k of visible) shown[k] = 1
  const items: Item[] = []
  const { gaps, lead, trail } = m.props
  const hiddenOf = (k: number | undefined) =>
    k === undefined ? undefined : k === 0 ? lead : k > gaps.length ? trail : gaps[k - 1]![1]
  if (m.win > 0) items.push({ kind: 'prev', count: m.hs.filter(u => u < m.win).length, lines: m.win })
  let last = m.win > 0 ? hiOf(units[m.win - 1]!) : -1
  let end = m.win
  for (; end < units.length; end++) {
    const u = units[end]!
    const lo = loOf(u)
    // A stretch left out of the text lies before this row: before the first piece, or between two.
    let farK: number | undefined = end === 0 && lead > 0 ? 0 : undefined
    if (far.size > 0) for (let r = last + 1; r <= lo; r++) farK = far.get(r) ?? farK
    if (lo > last + 1 || farK !== undefined) {
      const header = hunkHeader(m, rows, shown, lo)
      items.push({ kind: 'gap', from: last + 1, to: lo, header, far: farK, hidden: hiddenOf(farK) })
    }
    const blockTo = blockEnd.get(lo)
    const block: [number, number] | undefined = blockTo === undefined ? undefined : [lo, blockTo]
    // A change's first row keeps room at its right end for the Revert label.
    const right = segsOf(u.r, width, block ? width - REVERT.length : width)
    const left = segsOf(u.l, leftWidth, leftWidth)
    for (let i = 0; i < Math.max(right.length, left.length); i++) {
      items.push({ kind: 'line', v: end, seg: right[i], left: left[i], block: i === 0 ? block : undefined })
    }
    last = Math.max(last, hiOf(u))
  }
  if ((last >= 0 && last < rows.length - 1) || (trail > 0 && units.length > 0)) {
    const farK = trail > 0 ? gaps.length + 1 : undefined
    items.push({ kind: 'gap', from: last + 1, to: rows.length, header: '', far: farK, hidden: hiddenOf(farK) })
  }
  if (visible.length === 0 && rows.length > 0) items.push({ kind: 'gap', from: 0, to: rows.length, header: '' })
  m.items = items
  m.shown = units.length
  m.stop = end
}

/** The last hunk that starts at or before unit `u`, -1 before the first. */
function hunkAt(hs: readonly number[], u: number): number {
  let h = -1
  while (h + 1 < hs.length && hs[h + 1]! <= u) h++

  return h
}

/** Whether unit `v` shows a changed row. */
function isChangeUnit(m: Model, rows: readonly Row[], v: number): boolean {
  const u = m.units[v]

  return u !== undefined && [u.l, u.r].some(k => k !== undefined && rows[k]!.kind !== 'ctx')
}

/**
 * Where "Scroll down" (`dir` 1) and "Scroll up" move a drawing too large to
 * draw at once: by half of it, so half of what was drawn stays in sight. On,
 * from the unit at half its size, never past the first unit it left out; back,
 * by half its units. A start inside a change block goes back to the block's.
 */
function moveWindow(m: Model, dir: 1 | -1): number {
  const { rows } = diffOf(m)
  const { win, stop } = m
  let to = dir > 0 ? Math.min(Math.max(win + 1, m.midAt), stop) : Math.max(0, win - Math.ceil((stop - win) / 2))
  let at = to
  while (at > 0 && isChangeUnit(m, rows, at) && isChangeUnit(m, rows, at - 1)) at--
  if (dir < 0 || at > win) to = at

  return to
}

/** The item the cursor is on, and its cell column there. */
function cursorAt(m: Model): { index: number; x: number } {
  const { rows } = diffOf(m)
  for (let n = 0; n < m.items.length; n++) {
    const item = m.items[n]!
    const seg = item.kind === 'line' ? item.seg : undefined
    if (!seg || rows[seg.k]!.newNo !== m.cur.row + 1) continue
    if (m.cur.col >= seg.from && (m.cur.col < seg.to || (seg.last && m.cur.col === seg.to))) {
      const { x } = measure(m.lines[m.cur.row]!)

      return { index: n, x: x[m.cur.col]! - x[seg.from]! }
    }
  }

  return { index: -1, x: 0 }
}

/** Where the pointer is across the region: within the cell where the surface tells, else the cell's left edge. */
const cellX = (ev: ClientPointerEvent) => ev.fine?.x ?? ev.x

/** The position under a cell of an item's edited text, or undefined off the editable lines. */
function posIn(m: Model, item: Item | undefined, cellX: number): Pos | undefined {
  const seg = item?.kind === 'line' ? item.seg : undefined
  if (!seg) return undefined
  const row = diffOf(m).rows[seg.k]!
  if (row.newNo === 0) return undefined
  const line = m.lines[row.newNo - 1]!
  const { x } = measure(line)
  // A click lands between the two characters nearest it, as a text field's does.
  const target = x[seg.from]! + Math.max(0, cellX)
  let col = seg.from
  while (col < seg.to && (x[col]! + x[col + 1]!) / 2 <= target) col++
  if (!seg.last && col === seg.to && seg.to > seg.from) col = seg.to - 1

  return { row: row.newNo - 1, col }
}

/** Up or down by region rows: across wrapped segments, past removed lines and headers, moving the window at its edge. */
function vertical(m: Model, dir: 1 | -1, times = 1): void {
  let { index, x } = cursorAt(m)
  if (index < 0) return
  const goal = m.goalX ?? x
  let target: Pos | undefined
  for (let step = 0; step < times; step++) {
    let n = index + dir
    while (n >= 0 && n < m.items.length && !posIn(m, m.items[n], 0)) n += dir
    if (n < 0 || n >= m.items.length) {
      const edge = m.items[dir > 0 ? m.items.length - 1 : 0]
      if (edge?.kind !== (dir > 0 ? 'next' : 'prev')) break
      // Move the window on and look again from where the cursor is.
      const p = target ?? m.cur
      m.cur = p
      const was = m.win
      m.win = moveWindow(m, dir)
      m.isFollowing = false
      layout(m)
      index = cursorAt(m).index
      if (index < 0 || m.win === was) break
      step--
      continue
    }
    index = n
    target = posIn(m, m.items[n], goal)
  }
  if (target) m.cur = target
  else m.cur = dir < 0 ? { row: m.cur.row, col: 0 } : { row: m.cur.row, col: m.lines[m.cur.row]!.length }
  m.goalX = goal
}

/** Home as editors do it: to the first non-blank, or to column 0 when already there. */
function homeOf(line: string, col: number): number {
  const first = /^[ \t]*/.exec(line)![0].length

  return col === first ? 0 : first
}

function wordAround(m: Model, p: Pos): [Pos, Pos] {
  const line = m.lines[p.row]!
  let a = p.col
  let b = p.col
  if (isWordChar(line[a]) || isWordChar(line[a - 1])) {
    while (a > 0 && isWordChar(line[a - 1])) a--
    while (b < line.length && isWordChar(line[b])) b++
  } else if (b < line.length) {
    b++
  }

  return [
    { row: p.row, col: a },
    { row: p.row, col: b },
  ]
}

function indentLines(m: Model, outdent: boolean): void {
  const sel = selection(m)
  const from = sel ? sel[0].row : m.cur.row
  const to = sel ? (sel[1].col === 0 && sel[1].row > from ? sel[1].row - 1 : sel[1].row) : m.cur.row
  for (let r = from; r <= to; r++) {
    const line = m.lines[r]!
    let delta = 0
    if (outdent) {
      const lead = line.startsWith('\t') ? 1 : (/^ {1,4}/.exec(line)?.[0].length ?? 0)
      m.lines[r] = line.slice(lead)
      delta = -lead
    } else {
      m.lines[r] = m.indent + line
      delta = m.indent.length
    }
    if (m.cur.row === r) m.cur = { row: r, col: Math.max(0, m.cur.col + delta) }
    if (m.anchor?.row === r) m.anchor = { row: r, col: Math.max(0, m.anchor.col + delta) }
  }
}

/** Puts a change back as it was in the base: its added lines give way to its removed ones. */
function revertBlock(m: Model, [s, e]: [number, number]): void {
  const { rows } = diffOf(m)
  let at = 0
  for (let k = 0; k < s; k++) if (rows[k]!.newNo > 0) at++
  const block = rows.slice(s, e)
  snapshot(m, 'revert')
  m.lines.splice(
    at,
    block.filter(r => r.kind === 'add').length,
    ...block.filter(r => r.kind === 'del').map(r => r.text),
  )
  if (m.lines.length === 0) m.lines = ['']
  m.cur = clamp(m, { row: at, col: 0 })
  m.anchor = null
  m.version++
  post(m)
}

/** Moves the cursor to a change: the next or previous one from it, or the first or last. False when there is none. */
function jump(m: Model, kind: EditorCommand['kind']): boolean {
  const { rows, blocks } = diffOf(m)
  // The line a change is reached at: its first added line, or for a removal the line after it.
  const lineOf = ([s, e]: [number, number]) => {
    for (let k = s; k < rows.length; k++) if (rows[k]!.newNo > 0) return rows[k]!.newNo - 1
    for (let k = e - 1; k >= 0; k--) if (rows[k]!.newNo > 0) return rows[k]!.newNo - 1

    return 0
  }
  const cursorK = m.isActive ? rows.findIndex(r => r.newNo === m.cur.row + 1) : -1
  let block: [number, number] | undefined
  if (kind === 'first' || (kind === 'next' && !m.isActive)) block = blocks[0]
  else if (kind === 'last' || (kind === 'prev' && !m.isActive)) block = blocks[blocks.length - 1]
  else if (kind === 'next') block = blocks.find(([s]) => s > cursorK)
  else if (kind === 'prev') block = blocks.filter(b => lineOf(b) < m.cur.row).pop()
  if (!block) return false
  m.cur = clamp(m, { row: lineOf(block), col: 0 })
  m.anchor = null
  m.isActive = true
  m.isBlinkOn = true
  m.isFollowing = true
  m.goalX = null
  m.revealSeq++

  return true
}

/** F7 past the last change, or Shift+F7 before the first: the pane moves on to the next file. */
function step(m: Model, dir: 1 | -1): void {
  if (jump(m, dir > 0 ? 'next' : 'prev')) return
  m.edge = dir
  m.edgeSeq++
}

function matchesOf(m: Model): Match[] {
  const query = m.find?.query ?? ''
  if (!query) return []
  if (m.matches && m.matches.version === m.version && m.matches.query === query) return m.matches.list
  // Smart case: a capital letter in the query makes it match case.
  const isExact = query !== query.toLowerCase()
  const needle = isExact ? query : query.toLowerCase()
  const list: Match[] = []
  for (let row = 0; row < m.lines.length && list.length < MAX_MATCHES; row++) {
    const line = isExact ? m.lines[row]! : m.lines[row]!.toLowerCase()
    for (let at = line.indexOf(needle); at >= 0 && list.length < MAX_MATCHES; at = line.indexOf(needle, at + 1)) {
      list.push({ row, from: at, to: at + needle.length })
    }
  }
  m.matches = { version: m.version, query, list }

  return list
}

/** The match the selection is, if it is one. */
function currentMatch(m: Model): number {
  const sel = selection(m)
  if (!sel || sel[0].row !== sel[1].row) return -1

  return matchesOf(m).findIndex(x => x.row === sel[0].row && x.from === sel[0].col && x.to === sel[1].col)
}

/** Selects the next or previous match from the cursor, wrapping around; `isHere` lets the match at the cursor count. */
function findStep(m: Model, dir: 1 | -1, isHere = false): void {
  const list = matchesOf(m)
  if (!list.length) return
  const sel = selection(m)
  const at = sel ? sel[0] : m.cur
  const start = (x: Match) => ({ row: x.row, col: x.from })
  const pick =
    dir > 0
      ? (list.find(x => (isHere ? !before(start(x), at) : before(at, start(x)))) ?? list[0]!)
      : (list.filter(x => before(start(x), at)).pop() ?? list[list.length - 1]!)
  m.anchor = { row: pick.row, col: pick.from }
  m.cur = { row: pick.row, col: pick.to }
  m.isActive = true
  m.isFollowing = true
  m.revealSeq++
}

function openFind(m: Model): void {
  const sel = selection(m)
  const picked = sel && sel[0].row === sel[1].row ? textBetween(m, sel[0], sel[1]) : ''
  m.find = { query: picked || m.find?.query || '', replace: m.find?.replace ?? '', field: 'find', isTyping: true }
  m.isActive = true
}

function replaceOne(m: Model): boolean {
  if (currentMatch(m) < 0) {
    findStep(m, 1, true)
    return false
  }
  snapshot(m, 'replace')
  insert(m, m.find!.replace)
  m.version++
  findStep(m, 1, true)

  return true
}

function replaceAll(m: Model): boolean {
  const list = matchesOf(m)
  if (!list.length) return false
  snapshot(m, 'replace')
  const rep = m.find!.replace
  for (let n = list.length - 1; n >= 0; n--) {
    const x = list[n]!
    const line = m.lines[x.row]!
    m.lines[x.row] = line.slice(0, x.from) + rep + line.slice(x.to)
  }
  m.anchor = null
  m.cur = clamp(m, m.cur)
  m.version++

  return true
}

/** A key while the find bar has the keys. True when the text changed. */
function onFindKey(m: Model, ev: ClientKeyEvent): boolean {
  const f = m.find!
  const k = ev.key
  const mod = ev.ctrl || ev.meta
  const field = f.field
  const set = (value: string) => {
    if (field === 'find') {
      f.query = value
      findStep(m, 1, true)
    } else f.replace = value
  }
  const value = field === 'find' ? f.query : f.replace
  if (mod && k.toLowerCase() === 'f') m.find = null
  else if (k === 'return' || k === 'enter') {
    if (field === 'find') findStep(m, ev.shift ? -1 : 1)
    else return mod ? replaceAll(m) : replaceOne(m)
  } else if (k === 'tab') f.field = field === 'find' ? 'replace' : 'find'
  else if (k === 'up' || k === 'down') findStep(m, k === 'up' ? -1 : 1)
  else if (k === 'backspace') set(mod ? '' : value.slice(0, -1))
  else if (k === 'space') set(value + ' ')
  else if (!mod && !SPECIAL.has(k) && k.length > 0) set(value + k.replace(/\r?\n/g, ' '))

  return false
}

function onKey(m: Model, ev: ClientKeyEvent): void {
  m.isActive = true
  m.isBlinkOn = true
  m.isFollowing = true
  const k = ev.key
  const lower = k.toLowerCase()
  const mod = ev.ctrl || ev.meta
  const shift = ev.shift === true
  let edited = false
  let keepGoal = false
  const edit = (kind: string, fn: () => void) => {
    snapshot(m, kind)
    fn()
    edited = true
  }
  const moveTo = (p: Pos) => {
    if (shift) m.anchor = m.anchor ?? { ...m.cur }
    else m.anchor = null
    m.cur = clamp(m, p)
  }
  const line = m.lines[m.cur.row]!
  const sel = selection(m)

  if (m.find?.isTyping && !(mod && (lower === 's' || lower === 'z' || lower === 'y'))) {
    if (onFindKey(m, ev)) post(m)
    else postSelection(m)
    redraw(m)
    return
  }

  if (mod && lower === 's') {
    m.saveSeq++
    post(m)
  } else if (mod && lower === 'f') {
    openFind(m)
  } else if (mod && (k === 'return' || k === 'enter')) {
    m.commentSeq++
    post(m)
  } else if (k === 'f7') {
    step(m, shift ? -1 : 1)
    post(m)
  } else if (mod && (lower === 'z' || lower === 'y')) {
    const isRedo = lower === 'y' || shift
    if (isRedo ? restore(m, m.redo, m.undo) : restore(m, m.undo, m.redo)) {
      m.version++
      post(m)
    }
  } else if (mod && lower === 'a') {
    m.anchor = { row: 0, col: 0 }
    m.cur = { row: m.lines.length - 1, col: m.lines[m.lines.length - 1]!.length }
  } else if (mod && (lower === 'c' || lower === 'x')) {
    // Without a selection, the whole line, as editors do.
    m.clip = sel ? textBetween(m, sel[0], sel[1]) : line + m.eol
    m.copySeq++
    if (lower === 'x') {
      edit('cut', () => {
        if (sel) removeBetween(m, sel[0], sel[1])
        else if (m.lines.length > 1) {
          m.lines.splice(m.cur.row, 1)
          m.cur = clamp(m, { row: m.cur.row, col: 0 })
        } else m.lines[0] = ''
      })
    } else {
      post(m)
    }
  } else if (mod && (k === 'left' || k === 'home')) {
    moveTo({ row: m.cur.row, col: homeOf(line, m.cur.col) })
  } else if (mod && (k === 'right' || k === 'end')) {
    moveTo({ row: m.cur.row, col: line.length })
  } else if (mod && k === 'up') {
    moveTo({ row: 0, col: 0 })
  } else if (mod && k === 'down') {
    moveTo({ row: m.lines.length - 1, col: m.lines[m.lines.length - 1]!.length })
  } else if (mod && k === 'backspace') {
    if (sel) edit('delete', () => removeBetween(m, sel[0], sel[1]))
    else if (m.cur.col > 0) edit('delete', () => removeBetween(m, { row: m.cur.row, col: 0 }, m.cur))
  } else if (mod) {
    return
  } else if (k === 'up' || k === 'down' || k === 'pageup' || k === 'pagedown') {
    if (shift) m.anchor = m.anchor ?? { ...m.cur }
    else m.anchor = null
    vertical(m, k === 'up' || k === 'pageup' ? -1 : 1, k.startsWith('page') ? 15 : 1)
    m.isFollowing = true
    keepGoal = true
  } else if (k === 'left') {
    if (sel && !shift) moveTo(sel[0])
    else if (m.cur.col > 0) moveTo({ row: m.cur.row, col: m.cur.col - 1 })
    else if (m.cur.row > 0) moveTo({ row: m.cur.row - 1, col: m.lines[m.cur.row - 1]!.length })
  } else if (k === 'right') {
    if (sel && !shift) moveTo(sel[1])
    else if (m.cur.col < line.length) moveTo({ row: m.cur.row, col: m.cur.col + 1 })
    else if (m.cur.row < m.lines.length - 1) moveTo({ row: m.cur.row + 1, col: 0 })
  } else if (k === 'home') {
    moveTo({ row: m.cur.row, col: homeOf(line, m.cur.col) })
  } else if (k === 'end') {
    moveTo({ row: m.cur.row, col: line.length })
  } else if (k === 'return' || k === 'enter') {
    const indent = /^[ \t]*/.exec(line.slice(0, m.cur.col))![0]
    edit('newline', () => insert(m, '\n' + indent))
  } else if (k === 'backspace') {
    if (sel) edit('delete', () => removeBetween(m, sel[0], sel[1]))
    else if (m.cur.col > 0) {
      edit('backspace', () => removeBetween(m, { row: m.cur.row, col: m.cur.col - 1 }, m.cur))
    } else if (m.cur.row > 0) {
      edit('backspace', () => removeBetween(m, { row: m.cur.row - 1, col: m.lines[m.cur.row - 1]!.length }, m.cur))
    }
  } else if (k === 'delete') {
    if (sel) edit('delete', () => removeBetween(m, sel[0], sel[1]))
    else if (m.cur.col < line.length) {
      edit('delete', () => removeBetween(m, m.cur, { row: m.cur.row, col: m.cur.col + 1 }))
    } else if (m.cur.row < m.lines.length - 1) {
      edit('delete', () => removeBetween(m, m.cur, { row: m.cur.row + 1, col: 0 }))
    }
  } else if (k === 'tab') {
    if (shift || (sel && sel[0].row !== sel[1].row)) edit('indent', () => indentLines(m, shift))
    else edit('type', () => insert(m, m.indent))
  } else if (k === 'space') {
    edit('type', () => insert(m, ' '))
  } else if (!SPECIAL.has(k) && k.length > 0) {
    // A single character typed, or a paste arriving as one string.
    edit(k.length === 1 ? 'type' : 'paste', () => insert(m, k))
  }

  if (!keepGoal) m.goalX = null
  if (edited) {
    m.version++
    post(m)
  } else postSelection(m)
  redraw(m)
}

function onPointer(m: Model, ev: ClientPointerEvent): void {
  if (ev.type === 'up') {
    m.isDragging = false
    if (m.anchor && same(m.anchor, m.cur)) m.anchor = null
    postSelection(m)
    redraw(m)
    return
  }
  const n = ev.y - m.top
  if (ev.type === 'move') {
    if (!m.isDragging || ev.button !== 'left') return
    const at = Math.max(0, Math.min(m.items.length - 1, n))
    let p = posIn(m, m.items[at], cellX(ev) - m.textX)
    // Dragged past the top or bottom of the region: to the first or last line shown.
    if (!p && n < 0) p = m.items.map(item => posIn(m, item, 0)).find(Boolean)
    if (!p && n >= m.items.length) {
      const lines = m.items.filter(item => posIn(m, item, 0))
      p = posIn(m, lines[lines.length - 1], Infinity)
    }
    if (p && !same(p, m.cur)) {
      m.cur = p
      redraw(m)
    }
    return
  }
  if (ev.type !== 'down' || (ev.button !== undefined && ev.button !== 'left')) return

  m.isActive = true
  m.isBlinkOn = true
  m.goalX = null
  if (!m.props.isFocused) {
    m.focusSeq++
    post(m)
  }
  if (n < 0 && m.find) {
    // The find bar: a field takes the keys, a label does what it says.
    const hit = m.hits.find(h => ev.x >= h.from && ev.x < h.to)
    m.find.isTyping = true
    if (hit) hit.act()
    redraw(m)
    return
  }
  if (m.find) m.find.isTyping = false
  const item = m.items[n]
  if (item?.kind === 'line' && item.block && ev.x >= m.surface.columns - REVERT.length) {
    revertBlock(m, item.block)
    redraw(m)
    return
  }
  if (item?.kind === 'gap') {
    const { rows } = diffOf(m)
    for (let k = item.from; k < item.to; k++) if (rows[k]!.oldNo > 0) m.opened.add(rows[k]!.oldNo)
    if (item.far !== undefined) {
      // Lines left out of the text: the hooks module brings them in.
      m.expand = item.far
      m.expandSeq++
      post(m)
    }
    redraw(m)
    return
  }
  if (item?.kind === 'prev' || item?.kind === 'next') {
    m.win = moveWindow(m, item.kind === 'next' ? 1 : -1)
    m.isFollowing = false
    redraw(m)
    return
  }
  const p = posIn(m, item, cellX(ev) - m.textX)
  if (!p) {
    redraw(m)
    return
  }

  const t = now()
  const isRepeat = t - m.lastClick.at < 450 && m.lastClick.row === p.row && Math.abs(m.lastClick.col - p.col) <= 1
  const count = isRepeat ? m.lastClick.count + 1 : 1
  m.lastClick = { at: t, row: p.row, col: p.col, count }

  if (count === 2) {
    const [a, b] = wordAround(m, p)
    m.anchor = a
    m.cur = b
  } else if (count >= 3) {
    m.anchor = { row: p.row, col: 0 }
    m.cur = p.row < m.lines.length - 1 ? { row: p.row + 1, col: 0 } : { row: p.row, col: m.lines[p.row]!.length }
  } else {
    if (ev.shift) m.anchor = m.anchor ?? { ...m.cur }
    else m.anchor = { ...p }
    m.cur = p
    m.isDragging = true
  }
  redraw(m)
}

const pad = (s: string, w: number) => (s.length >= w ? s : ' '.repeat(w - s.length) + s)

type Style = { bg?: Color; inverse?: boolean; color?: Color }
const sameStyle = (a: Style, b: Style) => a.bg === b.bg && a.inverse === b.inverse && a.color === b.color

const Editor: ClientModule<EditorProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let m = surface.state?.m
  if (!m) {
    const fresh: Model = {
      instance: Math.random().toString(36).slice(2),
      surface,
      props,
      rev: -1,
      baseKey: '',
      eol: '\n',
      base: [],
      baseStates: [],
      lines: [''],
      cur: { row: 0, col: 0 },
      anchor: null,
      goalX: null,
      isActive: false,
      isBlinkOn: true,
      version: 0,
      opened: new Set(),
      win: 0,
      stop: Infinity,
      shown: 0,
      hs: [],
      midAt: 0,
      units: [],
      isFollowing: false,
      undo: [],
      redo: [],
      lastEdit: { kind: '', at: 0, row: -1 },
      saveSeq: 0,
      copySeq: 0,
      focusSeq: 0,
      commentSeq: 0,
      edgeSeq: 0,
      revealSeq: 0,
      expandSeq: 0,
      expand: 0,
      edge: 1,
      cmdSeq: 0,
      clip: '',
      sentSel: '',
      indent: '    ',
      find: null,
      hits: [],
      items: [],
      top: 0,
      numW: 1,
      textX: 0,
      isSplitDrawn: false,
      half: 0,
      isDragging: false,
      lastClick: { at: 0, row: -1, col: -1, count: 0 },
    }
    load(fresh, props)
    surface.onKey(ev => onKey(fresh, ev))
    surface.onPointer(ev => onPointer(fresh, ev))
    surface.every(530, () => {
      if (!fresh.isActive || !fresh.props.isFocused) return
      fresh.isBlinkOn = !fresh.isBlinkOn
      redraw(fresh)
    })
    surface.setState({ m: fresh })
    m = fresh
  }
  m.surface = surface
  if (props.language !== m.props.language) m.baseStates = lineStates(m.base, props.language ?? undefined)
  m.props = props
  if (props.rev !== m.rev) {
    // The file changed, or the person's edits were discarded: take the new
    // text, unless the person's unsaved edits are to be kept over it.
    if (props.conflict) m.rev = props.rev
    else load(m, props)
  } else if (props.baseKey !== m.baseKey) rebase(m, props)
  if (props.command && props.command.seq !== m.cmdSeq) {
    m.cmdSeq = props.command.seq
    const kind = props.command.kind
    if (kind === 'find') openFind(m)
    else if (kind === 'next' || kind === 'prev') step(m, kind === 'next' ? 1 : -1)
    else jump(m, kind)
    post(m)
  }
  m.top = m.find ? 1 : 0
  layout(m)

  const isTerminal = props.surface === 'terminal'
  const palette: Palette = isTerminal
    ? { ...TERMINAL, syntax: props.isDark ? DARK_SYNTAX : LIGHT_SYNTAX }
    : { ...APP, syntax: props.isDark ? DARK_SYNTAX : LIGHT_SYNTAX }
  const { rows, words, states } = diffOf(m)
  const ctxGutter = isTerminal ? undefined : props.isDark ? '#ffffff08' : '#00000008'
  const hunkText = isTerminal ? 'suggestion' : props.isDark ? '#79c0ff' : '#0969da'
  const showCursor = m.isActive && props.isFocused
  const sel = showCursor ? selection(m) : null
  const numW = m.numW
  const matches = m.find ? matchesOf(m) : []
  const matchesOn = new Map<number, Match[]>()
  for (const x of matches) matchesOn.set(x.row, [...(matchesOn.get(x.row) ?? []), x])
  const { newAt, oldAt } = diffOf(m)
  const isNoted = (r: number) => props.notes.some(([a, b]) => newAt[r]! + 1 >= a && newAt[r]! + 1 <= b)

  const inSelection = (row: number, col: number) => {
    if (!sel) return false
    const p = { row, col }

    return !before(p, sel[0]) && before(p, sel[1])
  }

  // Set while the rows are drawn; placed against the region, one row per item.
  let caret: { top: number; left: number } | null = null
  let here = -1

  const colours = (kind: Row['kind'] | undefined) => ({
    line: kind === 'add' ? palette.addLine : kind === 'del' ? palette.delLine : kind ? undefined : palette.blank,
    gutter: kind === 'add' ? palette.addGutter : kind === 'del' ? palette.delGutter : kind ? ctxGutter : palette.blank,
  })

  /** The marker cells and the text of one piece of a row; `isEdited` for the side the cursor works in. */
  const textOfSeg = (seg: Seg | undefined, n: number, isEdited: boolean) => {
    if (!seg) return [<Text key="m"> </Text>]
    const row = rows[seg.k]!
    const wordBg = row.kind === 'add' ? palette.addWord : palette.delWord
    const word = words.get(seg.k)
    const r = isEdited ? row.newNo - 1 : -1
    const { glyph, x } = measure(row.text)

    // Syntax colour of each code unit.
    const state = row.newNo > 0 ? (states[row.newNo - 1] ?? '') : (m!.baseStates[row.oldNo - 1] ?? '')
    const kinds: (TokenKind | undefined)[] = []
    if (props.language) {
      for (const t of tokenize(row.text, state, props.language).tokens) {
        for (let i = t.from; i < t.to; i++) kinds[i] = t.kind
      }
    }
    const found = r >= 0 ? (matchesOn.get(r) ?? []) : []

    const isCursorHere = showCursor && r >= 0 && r === m!.cur.row
    const isBlinkHere = isCursorHere && m!.isBlinkOn
    const cells: { text: string; style: Style }[] = []
    const push = (text: string, style: Style) => {
      const prev = cells[cells.length - 1]
      if (prev && sameStyle(prev.style, style)) prev.text += text
      else cells.push({ text, style })
    }
    for (let i = seg.from; i < seg.to; i++) {
      const kind = kinds[i]
      const style: Style = { color: kind ? palette.syntax[kind] : undefined }
      if (isTerminal && isBlinkHere && i === m!.cur.col) style.inverse = true
      else if (r >= 0 && inSelection(r, i)) {
        if (palette.selection) style.bg = palette.selection
        else style.inverse = true
      } else if (found.some(f => i >= f.from && i < f.to)) style.bg = palette.find
      else if (word && i >= word[0] && i < word[1]) style.bg = wordBg
      push(glyph[i] ?? '', style)
    }
    if (seg.last && r >= 0) {
      // A selection running on to the next line, and the terminal's cursor past the line's end.
      if (isTerminal && isBlinkHere && m!.cur.col === row.text.length) push(' ', { inverse: true })
      else if (inSelection(r, row.text.length))
        push(' ', palette.selection ? { bg: palette.selection } : { inverse: true })
    }

    if (isCursorHere && m!.cur.col >= seg.from && (m!.cur.col < seg.to || (seg.last && m!.cur.col === seg.to))) {
      here = n
      // The app's cursor: a thin bar at the left edge of the cell it stands before.
      if (!isTerminal && isBlinkHere) caret = { top: n, left: m!.textX + x[m!.cur.col]! - x[seg.from]! }
    }

    const marker = seg.first ? (row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ') : ' '
    const note = seg.first && r >= 0 && isNoted(r)

    return [
      ...(note
        ? [
            <Text key="n" mono color="suggestion">
              ●
            </Text>,
          ]
        : []),
      row.kind === 'ctx' ? (
        `${note ? '' : ' '}${marker} `
      ) : (
        <Text key="m" mono color={row.kind === 'add' ? 'success' : 'error'}>
          {`${note ? '' : ' '}${marker} `}
        </Text>
      ),
      // A run with no style of its own is the enclosing Text's: half the size drawn.
      ...cells.map((c, j) =>
        c.style.color || c.style.bg || c.style.inverse ? (
          <Text key={`${j}`} mono color={c.style.color} backgroundColor={c.style.bg} inverse={c.style.inverse}>
            {c.text}
          </Text>
        ) : (
          c.text
        ),
      ),
    ]
  }

  const numberOf = (seg: Seg | undefined, side: 'oldNo' | 'newNo') => {
    const no = seg?.first ? rows[seg.k]![side] : 0

    return pad(no > 0 ? String((side === 'oldNo' ? oldAt : newAt)[no - 1]! + 1) : '', numW)
  }

  const drawLine = (item: Extract<Item, { kind: 'line' }>, n: number) => {
    if (m!.isSplitDrawn) {
      const left = colours(item.left && rows[item.left.k]!.kind)
      const right = colours(item.seg && rows[item.seg.k]!.kind)

      return (
        <Box key={`l${n}`} flexDirection="row" width="100%">
          <Box width={numW + 1} flexShrink={0} backgroundColor={left.gutter}>
            <Text mono dimColor>
              {`${numberOf(item.left, 'oldNo')} `}
            </Text>
          </Box>
          <Box width={m!.half} flexShrink={0} backgroundColor={left.line}>
            <Text mono wrap="truncate-end">
              {textOfSeg(item.left, n, false)}
            </Text>
          </Box>
          <Box width={numW + 1} flexShrink={0} backgroundColor={right.gutter}>
            <Text mono dimColor>
              {`${numberOf(item.seg, 'newNo')} `}
            </Text>
          </Box>
          <Box flexGrow={1} backgroundColor={right.line}>
            <Text mono wrap="truncate-end">
              {textOfSeg(item.seg, n, true)}
            </Text>
          </Box>
        </Box>
      )
    }
    const seg = item.seg!
    const kind = rows[seg.k]!.kind
    const { line, gutter } = colours(kind)

    return (
      <Box key={`l${n}`} width="100%" backgroundColor={line}>
        <Text mono wrap="truncate-end">
          <Text key="g" mono dimColor backgroundColor={gutter}>
            {`${numberOf(seg, 'oldNo')} ${numberOf(seg, 'newNo')} `}
          </Text>
          {textOfSeg(seg, n, true)}
        </Text>
      </Box>
    )
  }

  // "↺ Revert" at the right end of each change's first row.
  const revertOf = (n: number) => (
    <Box
      key={`rv${n}`}
      position="absolute"
      top={n + m!.top}
      left={m!.surface.columns - REVERT.length}
      width={REVERT.length}
    >
      <Text mono color={hunkText} backgroundColor={palette.hunk}>
        {REVERT}
      </Text>
    </Box>
  )

  const { added, removed } = countChanges(rows)
  const drawItem = (item: Item, n: number) => {
    if (item.kind === 'line') return drawLine(item, n)
    if (item.kind !== 'gap') {
      // Counted in hunks; in lines where only unchanged ones are left (the whole file shown).
      const blocks = (n: number) => `${n} ${n === 1 ? 'block' : 'blocks'}`
      const label =
        item.kind === 'prev'
          ? `↑  Scroll up${item.count > 0 ? `  ·  ${blocks(item.count)} above` : ''}`
          : item.count > 0
            ? `↓  Scroll down  ·  ${blocks(item.count)} below`
            : `↓  Scroll down  ·  ${item.lines} more ${item.lines === 1 ? 'line' : 'lines'}`

      return (
        <Box key={`w${n}`} flexDirection="row" width="100%" backgroundColor={palette.hunk}>
          <Text mono color={hunkText} wrap="truncate-end">
            {' '.repeat(Math.max(0, m!.textX - 2))}
            {label}
          </Text>
        </Box>
      )
    }
    const count = item.to - item.from + (item.hidden ?? 0)
    const label =
      added + removed === 0 && item.from === 0 && item.to === rows.length
        ? `No changes from the base · show file (${count} lines)`
        : `${count} unchanged ${count === 1 ? 'line' : 'lines'}`

    return (
      <Box key={`g${n}`} flexDirection="row" width="100%" backgroundColor={palette.hunk}>
        <Text mono wrap="truncate-end">
          <Text mono color={hunkText}>
            {pad('⋯', numW * 2 + 1)}
            {'   '}
          </Text>
          {item.header ? (
            <Text mono color={hunkText}>
              {item.header}
            </Text>
          ) : (
            ''
          )}
          <Text dimColor>
            {item.header ? '  ' : ''}
            {label}
          </Text>
        </Text>
      </Box>
    )
  }

  // Every hunk is drawn while the rows serialize within the budget; past it the rest waits behind "Scroll down".
  const budget = props.budget > 0 ? props.budget : BUDGET
  const room = budget * BLOCK_ROOM
  let drawn: ReturnType<typeof drawItem>[] = []
  const upTo: number[] = []
  // Each change's Revert label is drawn beside its rows, and counts with them.
  const revertSize = JSON.stringify(revertOf(0)).length
  for (let n = 0, sum = 0; n < m.items.length && sum <= room; n++) {
    const item = m.items[n]!
    drawn.push(drawItem(item, n))
    sum += JSON.stringify(drawn[n]).length + (item.kind === 'line' && item.block ? revertSize : 0)
    upTo.push(sum)
  }
  const pastAt = (max: number) => upTo.findIndex((size, n) => size > max && m!.items[n]!.kind === 'line')
  const over = drawn.length < m.items.length ? Math.max(pastAt(budget), 0) : pastAt(budget)
  if (over >= 0) {
    const lineAt = (item: Item | undefined) => (item?.kind === 'line' ? item.v : -1)
    const firstV = lineAt(m.items.find(item => item.kind === 'line'))
    const cutAt = (v: number) => {
      const cut = m!.items.findIndex(item => lineAt(item) >= v)
      return cut < 0 ? m!.items.length : m!.items[cut - 1]?.kind === 'gap' ? cut - 1 : cut
    }
    const isChange = (v: number) => isChangeUnit(m!, rows, v)
    // The first unit not drawn; the window's first unit is always drawn, or it could never move on.
    let stopV = Math.max(lineAt(m.items[over]), firstV + 1)
    // A change block is not cut in two: the drawing goes on to its end, unless it is too long to draw at all.
    while (stopV < m.stop && isChange(stopV) && isChange(stopV - 1)) stopV++
    if ((upTo[cutAt(stopV) - 1] ?? Infinity) > room) stopV = Math.max(lineAt(m.items[pastAt(room)]), firstV + 1)
    if (stopV < m.stop) {
      const next: Item = {
        kind: 'next',
        count: m.hs.filter(u => u >= stopV).length,
        lines: m.shown - stopV,
      }
      m.items = [...m.items.slice(0, cutAt(stopV)), ...(next.lines > 0 ? [next] : [])]
      m.stop = stopV
      caret = null
      here = -1
      drawn = m.items.map(drawItem)
    }
  }
  // Half of what is drawn, where scrolling down starts the next drawing.
  const total = upTo[Math.min(upTo.length, m.items.length) - 1] ?? 0
  const mid = m.items.find((item, n) => item.kind === 'line' && upTo[n]! > total / 2)
  m.midAt = mid?.kind === 'line' ? mid.v : m.stop
  const bar = caret as { top: number; left: number } | null

  // The find bar: fields and labels laid out cell by cell, so a click finds what it hit.
  let findBar = null
  m.hits = []
  if (m.find) {
    const f = m.find
    const spans: { text: string; color?: Color; bg?: Color; dim?: boolean; act?: () => void }[] = []
    const fieldBg = isTerminal ? undefined : props.isDark ? '#ffffff14' : '#0000000f'
    const field = (name: 'find' | 'replace', value: string, placeholder: string) => {
      const isOn = f.isTyping && f.field === name
      spans.push({
        text: ` ${value || placeholder}${isOn ? '▏' : ' '}`.padEnd(18),
        dim: !value,
        bg: isOn ? (palette.selection ?? fieldBg) : fieldBg,
        act: () => (f.field = name),
      })
    }
    const at = currentMatch(m)
    spans.push({ text: ' Find ', color: hunkText })
    field('find', f.query, 'text')
    spans.push({
      text: f.query
        ? `  ${at >= 0 ? at + 1 : '–'} of ${matches.length}${matches.length >= MAX_MATCHES ? '+' : ''}  `
        : '  ',
      dim: true,
    })
    spans.push({ text: ' ↑ ', color: hunkText, act: () => findStep(m!, -1) })
    spans.push({ text: ' ↓ ', color: hunkText, act: () => findStep(m!, 1) })
    spans.push({ text: '   Replace ', color: hunkText })
    field('replace', f.replace, 'with')
    spans.push({ text: '  ' })
    spans.push({ text: ' Replace ', color: hunkText, act: () => replaceOne(m!) && post(m!) })
    spans.push({ text: ' All ', color: hunkText, act: () => replaceAll(m!) && post(m!) })
    spans.push({ text: '  ✕ ', dim: true, act: () => (m!.find = null) })
    let x = 0
    for (const s of spans) {
      if (s.act) m.hits.push({ from: x, to: x + s.text.length, act: s.act })
      x += s.text.length
    }
    findBar = (
      <Box key="find" flexDirection="row" width="100%" backgroundColor={palette.hunk}>
        <Text mono wrap="truncate-end">
          {spans.map((s, j) => (
            <Text key={`s${j}`} mono color={s.color} backgroundColor={s.bg} dimColor={s.dim}>
              {s.text}
            </Text>
          ))}
        </Text>
      </Box>
    )
  }

  const reverts =
    m.surface.columns - REVERT.length > m.textX
      ? m.items.flatMap((item, n) => (item.kind === 'line' && item.block ? [revertOf(n)] : []))
      : []

  return (
    <Box flexDirection="column" width="100%" position="relative">
      {findBar}
      {drawn}
      {reverts}
      {here >= 0 ? <Box key="here" position="absolute" top={here + m.top} left={0} width={1} height={1} /> : null}
      {bar ? (
        // A thin bar pressed against the right edge of the cell before the cursor: on the boundary,
        // where a glyph drawn in the cell itself sits a little inside the next character.
        <Box
          key="caret"
          position="absolute"
          top={bar.top + m.top}
          left={bar.left - 1}
          width={1}
          flexDirection="row"
          justifyContent="flex-end"
        >
          <Text color="text">|</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export default Editor
