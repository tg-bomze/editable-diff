// The editor: one file's diff against its text before Claude's first edit,
// drawn the way GitHub Desktop draws one (old and new line numbers, hunk
// headers, syntax colours) and edited in place.
// Runs on the drawing thread; reaches the hooks module only by `surface.post`.
//
// Everything is drawn in the monospaced face, so a cell of the region is one
// column of text and the pointer lands where it is drawn. Long lines wrap to
// the region's width. A large diff is shown through a window of WINDOW rows
// that moves by STEP rows.

import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface, Color } from 'claude-code'

import type { EditorPost } from '../types'
import { applyPatch, countChanges, diffLines, fingerprint, splitLines, visibleRows, wordRanges } from './diff'
import type { Patch, Row } from './diff'
import { lineStates, tokenize } from './highlight'
import type { LineState, TokenKind } from './highlight'

export type EditorProps = {
  /** Absolute path: what a post names. */
  file: string
  /** The text to edit: the unsaved draft, else the file on disk. */
  text: string
  /** Turns `text` into the base (the text before Claude's first edit). */
  patch: Patch
  /** Bumped when the editor must take `text` afresh. */
  rev: number
  /** Fingerprint of the file on disk, to tell whether the editor holds unsaved edits. */
  diskHash: string
  /** The file changed on disk under unsaved edits: keep the edits until the person decides. */
  conflict: boolean
  /** Show the whole file, not only the changes. */
  expanded: boolean
  /** The file shown in the pane: only it draws a cursor. */
  isFocused: boolean
  /** The surface drawing it: the terminal gets theme colours and a block cursor. */
  surface: string
  /** The highlighter's language, or null to draw plain. */
  language: string | null
  isDark: boolean
}

type Pos = { row: number; col: number }

type Item =
  | { kind: 'line'; k: number; from: number; to: number; first: boolean; last: boolean }
  | { kind: 'gap'; from: number; to: number; header: string }
  | { kind: 'prev' | 'next'; count: number }

type Snap = { lines: string[]; cur: Pos; anchor: Pos | null }

type Model = {
  instance: string
  surface: ClientSurface<State>
  props: EditorProps
  rev: number
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
  diff?: { version: number; rows: Row[]; words: Map<number, [number, number]>; states: LineState[] }
  /** Base line numbers of unchanged lines the person opened. */
  opened: Set<number>
  /** The window's first row, as an index into the rows shown. */
  win: number
  /** Keep the cursor inside the window (after keys); off once the person moves the window. */
  isFollowing: boolean
  undo: Snap[]
  redo: Snap[]
  lastEdit: { kind: string; at: number; row: number }
  saveSeq: number
  copySeq: number
  focusSeq: number
  clip: string
  indent: string
  /** What the last layout put on each row of the region, for the pointer. */
  items: Item[]
  numW: number
  gutter: number
  isDragging: boolean
  lastClick: { at: number; row: number; col: number; count: number }
}

type State = { m: Model }

const TAB = 4
const UNDO = 300
const WINDOW = 100
const STEP = 50
/** The tree stays under the element bounds (100,000 characters serialized). */
const MAX_CHARS = 60_000
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
  hunk?: Color
  selection?: Color
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
  hunk: '#388bfd1f',
  selection: '#388bfd59',
}
const TERMINAL = {
  addLine: 'diffAddedDimmed',
  delLine: 'diffRemovedDimmed',
  addGutter: 'diffAddedDimmed',
  delGutter: 'diffRemovedDimmed',
  addWord: 'diffAddedWord',
  delWord: 'diffRemovedWord',
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
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < line.length) {
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
    } else {
      glyph.push(line[i]!)
      at += cellWidth(c)
    }
  }
  x.push(at)

  return { glyph, x }
}

/** Where a line wraps at `width` cells: segment starts, in code units. */
function wrapAt(x: number[], width: number): number[] {
  const starts = [0]
  if (!Number.isFinite(width) || width < 1) return starts
  let s = 0
  for (let i = 0; i < x.length - 1; i++) {
    if (x[i + 1]! - x[s]! > width && i > s) {
      starts.push(i)
      s = i
    }
  }

  return starts
}

function load(m: Model, props: EditorProps): void {
  const raw = splitLines(props.text)
  m.eol = props.text.includes('\r\n') ? '\r\n' : '\n'
  m.base = applyPatch(raw, props.patch).map(stripCR)
  m.baseStates = lineStates(m.base, props.language ?? undefined)
  m.lines = raw.map(stripCR)
  m.rev = props.rev
  m.cur = clamp(m, m.cur)
  m.anchor = null
  m.indent = m.lines.some(line => line.startsWith('\t')) ? '\t' : '    '
  m.version++
}

function clamp(m: Model, p: Pos): Pos {
  const row = Math.max(0, Math.min(m.lines.length - 1, p.row))

  return { row, col: Math.max(0, Math.min(m.lines[row]!.length, p.col)) }
}

const textOf = (m: Model) => m.lines.join(m.eol)

function diffOf(m: Model): NonNullable<Model['diff']> {
  if (!m.diff || m.diff.version !== m.version) {
    const rows = diffLines(m.base, m.lines)
    m.diff = {
      version: m.version,
      rows,
      words: wordRanges(rows),
      states: lineStates(m.lines, m.props.language ?? undefined),
    }
  }

  return m.diff
}

function selection(m: Model): [Pos, Pos] | null {
  if (!m.anchor || same(m.anchor, m.cur)) return null

  return before(m.anchor, m.cur) ? [m.anchor, m.cur] : [m.cur, m.anchor]
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
  const data: EditorPost = {
    path: m.props.file,
    instance: m.instance,
    text,
    isDirty: fingerprint(text) !== m.props.diskHash,
    saveSeq: m.saveSeq,
    copySeq: m.copySeq,
    focusSeq: m.focusSeq,
    clip: m.clip,
  }
  m.surface.post(data)
}

function redraw(m: Model): void {
  m.surface.setState({ m })
}

/** "@@ -a,b +c,d @@" for the rows shown from visible index `start` up to the next gap. */
function hunkHeader(rows: readonly Row[], visible: readonly number[], start: number): string {
  let oldStart = 0
  let newStart = 0
  let oldCount = 0
  let newCount = 0
  for (let n = start; n < visible.length && (n === start || visible[n]! === visible[n - 1]! + 1); n++) {
    const row = rows[visible[n]!]!
    if (row.oldNo > 0) {
      if (!oldStart) oldStart = row.oldNo
      oldCount++
    }
    if (row.newNo > 0) {
      if (!newStart) newStart = row.newNo
      newCount++
    }
  }

  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
}

/** Lays out the region's rows: the window over the rows shown, wrapped, with hunk headers between. */
function layout(m: Model): void {
  const { rows } = diffOf(m)
  const pinned = new Set<number>()
  let cursorK = -1
  rows.forEach((row, k) => {
    if (row.newNo === m.cur.row + 1) cursorK = k
    if (row.kind === 'ctx' && m.opened.has(row.oldNo)) pinned.add(k)
  })
  if (m.isActive && cursorK >= 0) pinned.add(cursorK)
  const visible = m.props.expanded ? rows.map((_, k) => k) : visibleRows(rows, pinned)

  if (m.isFollowing && cursorK >= 0) {
    const at = visible.indexOf(cursorK)
    if (at >= 0 && at < m.win) m.win = Math.max(0, at - 10)
    else if (at >= m.win + WINDOW) m.win = at - WINDOW + 10
  }
  m.win = Math.max(0, Math.min(m.win, visible.length - WINDOW))

  m.numW = String(Math.max(1, m.lines.length, m.base.length)).length
  m.gutter = m.numW * 2 + 5
  const width = m.surface.columns > m.gutter + 8 ? m.surface.columns - m.gutter : Infinity

  const items: Item[] = []
  if (m.win > 0) items.push({ kind: 'prev', count: m.win })
  let last = m.win > 0 ? visible[m.win - 1]! : -1
  let budget = MAX_CHARS
  let end = m.win
  for (; end < visible.length && end < m.win + WINDOW && budget > 0; end++) {
    const k = visible[end]!
    if (k > last + 1) items.push({ kind: 'gap', from: last + 1, to: k, header: hunkHeader(rows, visible, end) })
    const text = rows[k]!.text
    const starts = wrapAt(measure(text).x, width)
    starts.forEach((from, n) => {
      const to = n + 1 < starts.length ? starts[n + 1]! : text.length
      items.push({ kind: 'line', k, from, to, first: n === 0, last: n === starts.length - 1 })
    })
    budget -= text.length * 2 + 400 * starts.length
    last = k
  }
  if (end < visible.length) items.push({ kind: 'next', count: visible.length - end })
  else if (last >= 0 && last < rows.length - 1) items.push({ kind: 'gap', from: last + 1, to: rows.length, header: '' })
  if (visible.length === 0 && rows.length > 0) items.push({ kind: 'gap', from: 0, to: rows.length, header: '' })
  m.items = items
}

/** The region row the cursor is on, and its cell column there. */
function cursorAt(m: Model): { index: number; x: number } {
  const { rows } = diffOf(m)
  for (let n = 0; n < m.items.length; n++) {
    const item = m.items[n]!
    if (item.kind !== 'line' || rows[item.k]!.newNo !== m.cur.row + 1) continue
    if (m.cur.col >= item.from && (m.cur.col < item.to || (item.last && m.cur.col === item.to))) {
      const { x } = measure(m.lines[m.cur.row]!)

      return { index: n, x: x[m.cur.col]! - x[item.from]! }
    }
  }

  return { index: -1, x: 0 }
}

/** Where the pointer is across the region: within the cell where the surface tells, else the cell's left edge. */
const cellX = (ev: ClientPointerEvent) => ev.fine?.x ?? ev.x

/** The position under a cell of a line item, or undefined off the editable lines. */
function posIn(m: Model, item: Item | undefined, cellX: number): Pos | undefined {
  if (item?.kind !== 'line') return undefined
  const row = diffOf(m).rows[item.k]!
  if (row.newNo === 0) return undefined
  const line = m.lines[row.newNo - 1]!
  const { x } = measure(line)
  // A click lands between the two characters nearest it, as a text field's does.
  const target = x[item.from]! + Math.max(0, cellX)
  let col = item.from
  while (col < item.to && (x[col]! + x[col + 1]!) / 2 <= target) col++
  if (!item.last && col === item.to && item.to > item.from) col = item.to - 1

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
      m.win += dir * STEP
      m.isFollowing = false
      layout(m)
      index = cursorAt(m).index
      if (index < 0) break
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

const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_$]/u.test(ch)

function wordAround(m: Model, p: Pos): [Pos, Pos] {
  const line = m.lines[p.row]!
  let a = p.col
  let b = p.col
  if (isWord(line[a]) || isWord(line[a - 1])) {
    while (a > 0 && isWord(line[a - 1])) a--
    while (b < line.length && isWord(line[b])) b++
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

  if (mod && lower === 's') {
    m.saveSeq++
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
    const first = /^[ \t]*/.exec(line)![0].length
    moveTo({ row: m.cur.row, col: m.cur.col === first ? 0 : first })
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
    const first = /^[ \t]*/.exec(line)![0].length
    moveTo({ row: m.cur.row, col: m.cur.col === first ? 0 : first })
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
  }
  redraw(m)
}

function onPointer(m: Model, ev: ClientPointerEvent): void {
  if (ev.type === 'up') {
    m.isDragging = false
    if (m.anchor && same(m.anchor, m.cur)) m.anchor = null
    redraw(m)
    return
  }
  if (ev.type === 'move') {
    if (!m.isDragging || ev.button !== 'left') return
    const n = Math.max(0, Math.min(m.items.length - 1, ev.y))
    let p = posIn(m, m.items[n], cellX(ev) - m.gutter)
    // Dragged past the top or bottom of the region: to the first or last line shown.
    if (!p && ev.y < 0) p = m.items.map(item => posIn(m, item, 0)).find(Boolean)
    if (!p && ev.y >= m.items.length) {
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
  const item = m.items[ev.y]
  if (item?.kind === 'gap') {
    const { rows } = diffOf(m)
    for (let k = item.from; k < item.to; k++) if (rows[k]!.oldNo > 0) m.opened.add(rows[k]!.oldNo)
    redraw(m)
    return
  }
  if (item?.kind === 'prev' || item?.kind === 'next') {
    m.win += item.kind === 'next' ? STEP : -STEP
    m.isFollowing = false
    redraw(m)
    return
  }
  const p = posIn(m, item, cellX(ev) - m.gutter)
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
      isFollowing: false,
      undo: [],
      redo: [],
      lastEdit: { kind: '', at: 0, row: -1 },
      saveSeq: 0,
      copySeq: 0,
      focusSeq: 0,
      clip: '',
      indent: '    ',
      items: [],
      numW: 1,
      gutter: 0,
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
  }
  layout(m)

  const isTerminal = props.surface === 'terminal'
  const palette: Palette = isTerminal
    ? { ...TERMINAL, syntax: props.isDark ? DARK_SYNTAX : LIGHT_SYNTAX }
    : { ...APP, syntax: props.isDark ? DARK_SYNTAX : LIGHT_SYNTAX }
  const { rows, words, states } = diffOf(m)
  const showCursor = m.isActive && props.isFocused
  const sel = showCursor ? selection(m) : null
  const numW = m.numW

  const inSelection = (row: number, col: number) => {
    if (!sel) return false
    const p = { row, col }

    return !before(p, sel[0]) && before(p, sel[1])
  }

  const drawLine = (item: Extract<Item, { kind: 'line' }>, n: number) => {
    const row = rows[item.k]!
    const lineBg = row.kind === 'add' ? palette.addLine : row.kind === 'del' ? palette.delLine : undefined
    const gutterBg = row.kind === 'add' ? palette.addGutter : row.kind === 'del' ? palette.delGutter : undefined
    const wordBg = row.kind === 'add' ? palette.addWord : palette.delWord
    const word = words.get(item.k)
    const r = row.newNo - 1
    const { glyph, x } = measure(row.text)

    // Syntax colour of each code unit.
    const state = row.newNo > 0 ? (states[row.newNo - 1] ?? '') : (m!.baseStates[row.oldNo - 1] ?? '')
    const kinds: (TokenKind | undefined)[] = []
    if (props.language) {
      for (const t of tokenize(row.text, state, props.language).tokens) {
        for (let i = t.from; i < t.to; i++) kinds[i] = t.kind
      }
    }

    const isCursorHere = showCursor && r === m!.cur.row && m!.isBlinkOn
    const cells: { text: string; style: Style }[] = []
    const push = (text: string, style: Style) => {
      const prev = cells[cells.length - 1]
      if (prev && sameStyle(prev.style, style)) prev.text += text
      else cells.push({ text, style })
    }
    for (let i = item.from; i < item.to; i++) {
      const kind = kinds[i]
      const style: Style = { color: kind ? palette.syntax[kind] : undefined }
      if (isTerminal && isCursorHere && i === m!.cur.col) style.inverse = true
      else if (r >= 0 && inSelection(r, i)) {
        if (palette.selection) style.bg = palette.selection
        else style.inverse = true
      } else if (word && i >= word[0] && i < word[1]) style.bg = wordBg
      push(glyph[i] ?? '', style)
    }
    if (item.last && r >= 0) {
      // A selection running on to the next line, and the terminal's cursor past the line's end.
      if (isTerminal && isCursorHere && m!.cur.col === row.text.length) push(' ', { inverse: true })
      else if (inSelection(r, row.text.length))
        push(' ', palette.selection ? { bg: palette.selection } : { inverse: true })
    }

    // The app's cursor: a thin bar at the left edge of the cell it stands before.
    if (
      !isTerminal &&
      isCursorHere &&
      m!.cur.col >= item.from &&
      (m!.cur.col < item.to || (item.last && m!.cur.col === item.to))
    ) {
      caret = { top: n, left: m!.gutter + x[m!.cur.col]! - x[item.from]! }
    }

    const oldNo = item.first && row.oldNo > 0 ? String(row.oldNo) : ''
    const newNo = item.first && row.newNo > 0 ? String(row.newNo) : ''
    const marker = item.first ? (row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ') : ' '

    return (
      <Box key={`l${n}`} flexDirection="row" width="100%" backgroundColor={lineBg}>
        <Text mono wrap="truncate-end">
          <Text mono dimColor backgroundColor={gutterBg}>
            {pad(oldNo, numW)} {pad(newNo, numW)}{' '}
          </Text>
          <Text mono color={row.kind === 'add' ? 'success' : row.kind === 'del' ? 'error' : undefined}>
            {' '}
            {marker}{' '}
          </Text>
          {cells.map((c, j) => (
            <Text key={`c${j}`} mono color={c.style.color} backgroundColor={c.style.bg} inverse={c.style.inverse}>
              {c.text}
            </Text>
          ))}
        </Text>
      </Box>
    )
  }

  const { added, removed } = countChanges(rows)
  // Set while the rows are drawn; placed against the region, one row per item.
  let caret: { top: number; left: number } | null = null
  const drawn = m.items.map((item, n) => {
    if (item.kind === 'line') return drawLine(item, n)
    if (item.kind !== 'gap') {
      const label =
        item.kind === 'prev'
          ? `↑  Show previous ${Math.min(STEP, item.count)} lines`
          : `↓  Show next ${Math.min(STEP, item.count)} lines  (${item.count} more)`

      return (
        <Box key={`w${n}`} flexDirection="row" width="100%" backgroundColor={palette.hunk}>
          <Text mono color="suggestion" wrap="truncate-end">
            {' '.repeat(m!.gutter - 2)}
            {label}
          </Text>
        </Box>
      )
    }
    const count = item.to - item.from
    const label =
      added + removed === 0 && item.from === 0 && item.to === rows.length
        ? `No changes from the original · show file (${count} lines)`
        : `${count} unchanged ${count === 1 ? 'line' : 'lines'}`

    return (
      <Box key={`g${n}`} flexDirection="row" width="100%" backgroundColor={palette.hunk}>
        <Text mono dimColor wrap="truncate-end">
          {pad('↕', numW * 2 + 1)}
          {'   '}
          {item.header ? `${item.header}   ` : ''}
          {label}
        </Text>
      </Box>
    )
  })
  const bar = caret as { top: number; left: number } | null

  return (
    <Box flexDirection="column" width="100%" position="relative">
      {drawn}
      {bar ? (
        // A thin bar pressed against the right edge of the cell before the cursor: on the boundary,
        // where a glyph drawn in the cell itself sits a little inside the next character.
        <Box
          key="caret"
          position="absolute"
          top={bar.top}
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
