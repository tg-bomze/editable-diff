// The editor: one file's diff against its text before Claude's first edit,
// drawn as changed lines with CONTEXT lines around them, and edited in place.
// Runs on the drawing thread; reaches the hooks module only by `surface.post`.

import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { EditorPost } from '../types'
import { applyPatch, countChanges, diffLines, fingerprint, splitLines, visibleRows } from './diff'
import type { Patch, Row } from './diff'

export type EditorProps = {
  /** Absolute path: what a post names. */
  file: string
  /** Path drawn in the header. */
  display: string
  /** The text to edit: the unsaved draft, else the file on disk. */
  text: string
  /** Turns `text` into the base (the text before Claude's first edit). */
  patch: Patch
  rev: number
  /** Fingerprint of the file on disk, to tell whether the editor holds unsaved edits. */
  diskHash: string
  conflict: boolean
  isNew: boolean
}

type Item = { kind: 'row'; k: number } | { kind: 'gap'; count: number } | { kind: 'more'; count: number }

type Model = {
  instance: string
  surface: ClientSurface<State>
  props: EditorProps
  rev: number
  eol: string
  base: string[]
  lines: string[]
  row: number
  col: number
  scrollX: number
  isActive: boolean
  version: number
  view?: { version: number; row: number; rows: Row[]; visible: number[] }
  undo: { lines: string[]; row: number; col: number }[]
  saveSeq: number
  discardSeq: number
  keepSeq: number
  indent: string
  /** What the last drawing put on each row under the header, for the pointer. */
  items: Item[]
  gutter: number
}

type State = { m: Model }

const TAB = 4
const MAX_ITEMS = 600
const UNDO = 200
const SPECIAL = new Set([
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'return', 'enter',
  'backspace', 'delete', 'tab', 'space', 'escape', 'insert', 'clear',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
])

const stripCR = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line)

function load(m: Model, props: EditorProps): void {
  const raw = splitLines(props.text)
  m.eol = props.text.includes('\r\n') ? '\r\n' : '\n'
  m.base = applyPatch(raw, props.patch).map(stripCR)
  m.lines = raw.map(stripCR)
  m.rev = props.rev
  m.row = Math.min(m.row, m.lines.length - 1)
  m.col = Math.min(m.col, m.lines[m.row]!.length)
  m.indent = m.lines.some(line => line.startsWith('\t')) ? '\t' : '    '
  m.version++
}

function textOf(m: Model): string {
  return m.lines.join(m.eol)
}

function view(m: Model): { rows: Row[]; visible: number[]; cursorK: number } {
  if (!m.view || m.view.version !== m.version || m.view.row !== m.row) {
    const rows = m.view && m.view.version === m.version ? m.view.rows : diffLines(m.base, m.lines)
    const cursorK = rows.findIndex(row => row.newNo === m.row + 1)
    const pinned = new Set<number>(m.isActive && cursorK >= 0 ? [cursorK] : [])
    m.view = { version: m.version, row: m.row, rows, visible: visibleRows(rows, pinned) }
  }
  const cursorK = m.view.rows.findIndex(row => row.newNo === m.row + 1)

  return { rows: m.view.rows, visible: m.view.visible, cursorK }
}

/** The editable lines in view, top to bottom: where up and down go. */
function stops(m: Model): number[] {
  const { rows, visible } = view(m)
  const out: number[] = []
  for (const k of visible) if (rows[k]!.newNo > 0) out.push(rows[k]!.newNo - 1)

  return out
}

/** A line as drawn: tabs expanded, control characters made visible; `at[c]` is where column c lands. */
function shown(line: string): { text: string; at: number[] } {
  let text = ''
  const at: number[] = []
  for (const ch of line) {
    for (let u = 0; u < ch.length; u++) at.push(text.length)
    if (ch === '\t') text += ' '.repeat(TAB - (text.length % TAB))
    else if (ch < ' ' || ch === '\u007f') text += '�'
    else text += ch
  }
  at.push(text.length)

  return { text, at }
}

function columnAt(line: string, x: number): number {
  const { at } = shown(line)
  let col = 0
  while (col < line.length && at[col + 1]! <= x) col++

  return col
}

function snapshot(m: Model): void {
  m.undo.push({ lines: m.lines.slice(), row: m.row, col: m.col })
  if (m.undo.length > UNDO) m.undo.shift()
}

function insert(m: Model, s: string): void {
  const parts = s.replace(/\r\n?/g, '\n').split('\n')
  const line = m.lines[m.row]!
  const before = line.slice(0, m.col)
  const after = line.slice(m.col)
  if (parts.length === 1) {
    m.lines[m.row] = before + s + after
    m.col += s.length
    return
  }
  const last = parts[parts.length - 1]!
  m.lines.splice(m.row, 1, before + parts[0]!, ...parts.slice(1, -1), last + after)
  m.row += parts.length - 1
  m.col = last.length
}

function post(m: Model): void {
  const text = textOf(m)
  const data: EditorPost = {
    path: m.props.file,
    instance: m.instance,
    text,
    isDirty: fingerprint(text) !== m.props.diskHash,
    saveSeq: m.saveSeq,
    discardSeq: m.discardSeq,
    keepSeq: m.keepSeq,
  }
  m.surface.post(data)
}

function redraw(m: Model): void {
  m.surface.setState({ m })
}

function move(m: Model, to: number, col: number | 'keep' | 'end'): void {
  m.row = Math.max(0, Math.min(m.lines.length - 1, to))
  const len = m.lines[m.row]!.length
  m.col = col === 'end' ? len : col === 'keep' ? Math.min(m.col, len) : Math.min(col, len)
}

function onKey(m: Model, ev: ClientKeyEvent): void {
  m.isActive = true
  const k = ev.key
  const mod = ev.ctrl || ev.meta
  const nav = stops(m)
  const at = Math.max(0, nav.indexOf(m.row))
  let edited = false
  const edit = (fn: () => void) => {
    snapshot(m)
    fn()
    edited = true
  }

  if (mod && k.toLowerCase() === 's') {
    m.saveSeq++
    post(m)
  } else if (mod && k.toLowerCase() === 'z') {
    const prev = m.undo.pop()
    if (prev) {
      m.lines = prev.lines
      m.row = prev.row
      m.col = prev.col
      m.version++
      post(m)
    }
  } else if (mod) {
    return
  } else if (k === 'up') {
    if (at > 0) move(m, nav[at - 1]!, 'keep')
  } else if (k === 'down') {
    if (at < nav.length - 1) move(m, nav[at + 1]!, 'keep')
  } else if (k === 'pageup') {
    move(m, nav[Math.max(0, at - 10)] ?? m.row, 'keep')
  } else if (k === 'pagedown') {
    move(m, nav[Math.min(nav.length - 1, at + 10)] ?? m.row, 'keep')
  } else if (k === 'left') {
    if (m.col > 0) m.col--
    else if (at > 0) move(m, nav[at - 1]!, 'end')
  } else if (k === 'right') {
    if (m.col < m.lines[m.row]!.length) m.col++
    else if (at < nav.length - 1) move(m, nav[at + 1]!, 0)
  } else if (k === 'home') {
    m.col = 0
  } else if (k === 'end') {
    m.col = m.lines[m.row]!.length
  } else if (k === 'return' || k === 'enter') {
    const indent = /^[ \t]*/.exec(m.lines[m.row]!.slice(0, m.col))![0]
    edit(() => insert(m, '\n' + indent))
  } else if (k === 'backspace') {
    if (m.col > 0) {
      edit(() => {
        const line = m.lines[m.row]!
        m.lines[m.row] = line.slice(0, m.col - 1) + line.slice(m.col)
        m.col--
      })
    } else if (m.row > 0) {
      edit(() => {
        const prev = m.lines[m.row - 1]!
        m.lines.splice(m.row - 1, 2, prev + m.lines[m.row]!)
        m.row--
        m.col = prev.length
      })
    }
  } else if (k === 'delete') {
    const line = m.lines[m.row]!
    if (m.col < line.length) {
      edit(() => {
        m.lines[m.row] = line.slice(0, m.col) + line.slice(m.col + 1)
      })
    } else if (m.row < m.lines.length - 1) {
      edit(() => {
        m.lines.splice(m.row, 2, line + m.lines[m.row + 1]!)
      })
    }
  } else if (k === 'tab') {
    edit(() => insert(m, m.indent))
  } else if (k === 'space') {
    edit(() => insert(m, ' '))
  } else if (!SPECIAL.has(k) && k.length > 0) {
    edit(() => insert(m, k))
  }

  if (edited) {
    m.version++
    post(m)
  }
  redraw(m)
}

function onPointer(m: Model, ev: ClientPointerEvent): void {
  if (ev.type !== 'down' || (ev.button !== undefined && ev.button !== 'left')) return
  m.isActive = true
  const item = m.items[ev.y - 1]
  if (item?.kind === 'row') {
    const row = view(m).rows[item.k]!
    if (row.newNo > 0) {
      m.row = row.newNo - 1
      m.col = columnAt(m.lines[m.row]!, Math.max(0, ev.x - m.gutter + m.scrollX))
    }
  }
  redraw(m)
}

const digits = (n: number) => String(Math.max(1, n)).length
const pad = (s: string, w: number) => (s.length >= w ? s : ' '.repeat(w - s.length) + s)

const Editor: ClientModule<EditorProps, State> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  let m = surface.state?.m
  if (!m) {
    const fresh: Model = {
      instance: Math.random().toString(36).slice(2),
      surface, props, rev: -1, eol: '\n', base: [], lines: [''], row: 0, col: 0, scrollX: 0,
      isActive: false, version: 0, undo: [], saveSeq: 0, discardSeq: 0, keepSeq: 0,
      indent: '    ', items: [], gutter: 0,
    }
    load(fresh, props)
    surface.onKey(ev => onKey(fresh, ev))
    surface.onPointer(ev => onPointer(fresh, ev))
    surface.setState({ m: fresh })
    m = fresh
  }
  m.surface = surface
  m.props = props
  if (props.rev !== m.rev) {
    // Claude changed the file, or the person's edits were discarded: take the
    // new text, unless the person's unsaved edits are to be kept over it.
    if (props.conflict) m.rev = props.rev
    else load(m, props)
  }

  const { rows, visible, cursorK } = view(m)
  const { added, removed } = countChanges(rows)
  const isDirty = fingerprint(textOf(m)) !== props.diskHash

  const items: Item[] = []
  let last = -1
  for (const k of visible) {
    if (k > last + 1) items.push({ kind: 'gap', count: k - last - 1 })
    items.push({ kind: 'row', k })
    last = k
  }
  if (items.length > 0 && last < rows.length - 1) items.push({ kind: 'gap', count: rows.length - 1 - last })
  if (items.length > MAX_ITEMS) {
    const rest = items.length - MAX_ITEMS
    items.length = MAX_ITEMS
    items.push({ kind: 'more', count: rest })
  }
  m.items = items

  const oldW = digits(m.base.length)
  const newW = digits(m.lines.length)
  m.gutter = oldW + newW + 4
  const room = surface.columns > m.gutter ? surface.columns - m.gutter : Infinity

  if (m.isActive && cursorK >= 0 && Number.isFinite(room)) {
    const x = shown(m.lines[m.row]!).at[m.col]!
    if (x < m.scrollX) m.scrollX = x
    else if (x >= m.scrollX + room) m.scrollX = x - room + 1
  }

  const drawRow = (k: number) => {
    const row = rows[k]!
    const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
    const gutter = `${pad(row.oldNo ? String(row.oldNo) : '', oldW)} ${pad(row.newNo ? String(row.newNo) : '', newW)} ${marker} `
    const bg = row.kind === 'add' ? 'diffAdded' : row.kind === 'del' ? 'diffRemoved' : undefined
    const line = shown(row.text)
    const end = Number.isFinite(room) ? m.scrollX + room : undefined
    const fill = (s: string, used: number) =>
      Number.isFinite(room) && bg ? s + ' '.repeat(Math.max(0, room - used)) : s

    if (k === cursorK && m.isActive) {
      const x = line.at[m.col]!
      const before = line.text.slice(m.scrollX, x)
      const ch = line.text[x] ?? ' '
      const after = line.text.slice(x + 1, end)

      return (
        <Text key={`r${k}`} wrap="truncate-end" backgroundColor={bg}>
          <Text dimColor>{gutter}</Text>
          {before}
          <Text inverse>{ch}</Text>
          {fill(after, before.length + 1 + after.length)}
        </Text>
      )
    }
    const body = line.text.slice(m.scrollX, end)

    return (
      <Text key={`r${k}`} wrap="truncate-end" backgroundColor={bg}>
        <Text dimColor>{gutter}</Text>
        {fill(body, body.length)}
      </Text>
    )
  }

  return (
    <Box flexDirection="column" width="100%">
      <Text wrap="truncate-end">
        <Text bold>{props.display}</Text>
        {'  '}
        <Text color="success">+{added}</Text> <Text color="error">-{removed}</Text>
        {props.isNew ? <Text dimColor>  новый файл</Text> : ''}
        {isDirty ? <Text color="warning">  ● не сохранено</Text> : ''}
        {!m.isActive ? <Text dimColor>  (кликните, чтобы править)</Text> : ''}
      </Text>
      {added + removed === 0 && !m.isActive ? <Text dimColor>Нет отличий от исходной версии.</Text> : null}
      {items.map((item, n) =>
        item.kind === 'row' ? (
          drawRow(item.k)
        ) : (
          <Text key={`g${n}`} dimColor>
            {' '.repeat(Math.max(0, m.gutter - 4))}⋯ {item.kind === 'gap' ? `${item.count} без изменений` : `ещё ${item.count} строк не показано`}
          </Text>
        ),
      )}
      {props.conflict ? (
        <Text color="warning">Claude изменил этот файл, пока у вас были несохранённые правки.</Text>
      ) : null}
      <Box flexDirection="row">
        <Button
          key="save"
          label="Сохранить"
          variant={isDirty ? 'primary' : 'secondary'}
          dimColor={!isDirty}
          onPress={() => {
            m.saveSeq++
            post(m)
            redraw(m)
          }}
        />
        {isDirty ? (
          <Button
            key="discard"
            label={props.conflict ? 'Взять версию Claude' : 'Отменить мои правки'}
            onPress={() => {
              m.discardSeq++
              m.undo = []
              post(m)
              redraw(m)
            }}
          />
        ) : null}
        {props.conflict ? (
          <Button
            key="keep"
            label="Оставить мои"
            onPress={() => {
              m.keepSeq++
              post(m)
              redraw(m)
            }}
          />
        ) : null}
      </Box>
    </Box>
  )
}

export default Editor
