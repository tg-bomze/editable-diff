import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, RenderElement } from 'claude-code'

import type {
  BaseMode,
  Counters,
  EditorCommand,
  EditorPost,
  FileWindow,
  FilesPost,
  ReviewComment,
  SavedFile,
  SavedIndex,
  SavedSession,
  TrackedFile,
} from '../types'
import { countChanges, diffLines, fingerprint, makePatch, printable, splitLines, unifiedDiff } from './diff'
import { ROWS } from './files'
import type { FileRow } from './files'
import { languageOf } from './highlight'
import {
  expandGap,
  gapsOf,
  isTooLarge,
  shiftWindow,
  slices,
  spliceBack,
  windowAtChange,
  windowFor,
  windowKey,
} from './window'

const PANE = 'editable-diff'
const TITLE = "Claude's edits"
/** A Client's props go whole or not at all; past this the file is shown, not edited. */
const MAX_PROPS = 95_000
/** Past this a file goes to the editor as its hunks, or, shown whole, a part at a time. */
const WINDOW_AT = MAX_PROPS - 5_000
/** How often files are checked for changes made outside the pane. */
const POLL_MS = 1000
/** How many polls between reads of git HEAD, while the diff is drawn against it. */
const HEAD_POLLS = 5
/** Every how many polls the list is saved to the store, when it changed. */
const SAVE_POLLS = 2
/** What the store may take of one session's list, and of all sessions' together, in characters of JSON. */
const MAX_SAVED = 1_500_000
const MAX_STORE = 3_500_000
/** How many sessions' lists the store keeps; the oldest go first. */
const MAX_SESSIONS = 20
const INDEX = 'sessions'
/** What an editor's rows may serialize to at first, and at least after the surface refused its drawings. */
const BUDGET = 80_000
const MIN_BUDGET = 5_000
/** Past this many changed files, or this size of one, a shell command's changes are not taken in. */
const MAX_SHELL_FILES = 2000
const MAX_SHELL_BYTES = 1_000_000
/** How much text of files changed already is kept before a shell command. */
const MAX_SHELL_TOTAL = 20_000_000
/** How many paths a shell command names are looked at, before and after it. */
const MAX_NAMED = 64
/** What a read-only diff may take of a drawing, on a surface without an editor. */
const MAX_PLAIN_DIFF = 60_000
/** How many lines of code a review comment quotes to Claude. */
const QUOTE_LINES = 40

const files = atom({ plugin: 'editable-diff', key: 'files' } as const, [])
const drafts = atom({ plugin: 'editable-diff', key: 'drafts' } as const, {})
const nextId = atom({ plugin: 'editable-diff', key: 'nextId' } as const, 1)
const isConfirmingClear = atom({ plugin: 'editable-diff', key: 'isConfirmingClear' } as const, false)
/** The last counters each editor instance posted, so a counter that moved acts once, reloads included. */
const seen = atom({ plugin: 'editable-diff', key: 'seen' } as const, {})
const active = atom({ plugin: 'editable-diff', key: 'active' } as const, '')
const isPaneOpen = atom({ plugin: 'editable-diff', key: 'isPaneOpen' } as const, false)
const isEnabled = atom({ plugin: 'editable-diff', key: 'isEnabled' } as const, true)
const isChatEnabled = atom({ plugin: 'editable-diff', key: 'isChatEnabled' } as const, true)
const baseMode = atom({ plugin: 'editable-diff', key: 'baseMode' } as const, 'session')
const turnId = atom({ plugin: 'editable-diff', key: 'turnId' } as const, '')
const isSplit = atom({ plugin: 'editable-diff', key: 'isSplit' } as const, false)
const ignoreWhitespace = atom({ plugin: 'editable-diff', key: 'ignoreWhitespace' } as const, false)
const viewed = atom({ plugin: 'editable-diff', key: 'viewed' } as const, {})
const comments = atom({ plugin: 'editable-diff', key: 'comments' } as const, [])
const composing = atom({ plugin: 'editable-diff', key: 'composing' } as const, null)
const commands = atom({ plugin: 'editable-diff', key: 'commands' } as const, {})
const budgets = atom({ plugin: 'editable-diff', key: 'budgets' } as const, {})
const windows = atom({ plugin: 'editable-diff', key: 'windows' } as const, {})
const listScroll = atom({ plugin: 'editable-diff', key: 'listScroll' } as const, null)

const MODES: { mode: BaseMode; label: string; revert: string }[] = [
  { mode: 'session', label: 'Session start', revert: 'Revert to original' },
  { mode: 'turn', label: 'Last turn', revert: 'Undo last turn' },
  { mode: 'head', label: 'Git HEAD', revert: 'Revert to HEAD' },
]

/** The editor's action counters: each one that moved since the last post asks for its action once. */
const COUNTERS = [
  'saveSeq',
  'copySeq',
  'focusSeq',
  'commentSeq',
  'edgeSeq',
  'revealSeq',
  'expandSeq',
] as const satisfies readonly (keyof Counters)[]

const countersOf = (from: Partial<Counters>): Counters =>
  Object.fromEntries(COUNTERS.map(k => [k, from[k] ?? 0])) as Counters

function isPost(data: unknown): data is EditorPost {
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>

  return (
    typeof d.path === 'string' &&
    typeof d.instance === 'string' &&
    typeof d.text === 'string' &&
    typeof d.isDirty === 'boolean' &&
    COUNTERS.every(k => typeof d[k] === 'number') &&
    typeof d.cmdSeq === 'number' &&
    typeof d.clip === 'string' &&
    (d.edge === 1 || d.edge === -1) &&
    Array.isArray(d.sel) &&
    d.sel.length === 2 &&
    d.sel.every(n => typeof n === 'number') &&
    Array.isArray(d.cuts) &&
    d.cuts.every(n => typeof n === 'number') &&
    typeof d.expand === 'number'
  )
}

function relative(path: string, cwd: string): string {
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`

  return cwd && path.startsWith(root) ? path.slice(root.length) : path
}

function splitPath(display: string): { name: string; dir: string } {
  const at = display.lastIndexOf('/')

  return at < 0 ? { name: display, dir: '' } : { name: display.slice(at + 1), dir: display.slice(0, at) }
}

const fileCount = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`
const lineRange = (from: number, to: number) => (from === to ? `line ${from}` : `lines ${from}–${to}`)

function isSelect(data: unknown): data is Extract<FilesPost, { select: string }> {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).select === 'string'
}

function isHover(data: unknown): data is Extract<FilesPost, { isOver: boolean }> {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).isOver === 'boolean'
}

/** Whether the person's theme is a dark one; dark when it cannot be told. */
async function isDarkTheme($: EngineInterface): Promise<boolean> {
  try {
    const row = (await $.config.list()).find(r => r.key === 'theme')

    return !String(row?.value ?? '').includes('light')
  } catch {
    return true
  }
}

/** What the file's diff is drawn against in `mode`. */
function baseOf(f: TrackedFile, mode: BaseMode, turn: string): string {
  if (mode === 'turn') return f.turnId === turn && f.turnBase !== undefined ? f.turnBase : f.disk
  if (mode === 'head' && typeof f.head === 'string') return f.head

  return f.base
}

/**
 * What `f`'s editor holds when the whole file is too large to hand over: its
 * hunks, or a part of the whole file; undefined when it is not too large.
 * Once a file goes so it stays so, to keep its editor.
 */
function windowOf(
  f: TrackedFile,
  text: string,
  base: string,
  mode: BaseMode,
  kept?: FileWindow,
): FileWindow | undefined {
  if (!kept && !isTooLarge(base, text, WINDOW_AT)) return undefined

  return windowFor(base, text, f.rev, `${mode}:${fingerprint(base)}`, f.isExpanded, kept)
}

/** The session's folder, read at session start: paths under it are shown relative. */
let cwd = ''
/** Paths being written by a save right now: the poll leaves them alone. */
const writing = new Set<string>()
let isPolling = false
/** The pointer is over the file list: the wheel scrolls the list, not the pane. */
let isOverList = false
let polls = 0
/** The session's id, under which its list is saved. */
let sessionId = ''
/** The versions of the saved values when last saved, to save only on a change. */
let savedStamp = ''
/** The lines each editor last had under its cursor, for the Comment and Open buttons. */
const selOf = new Map<string, [number, number]>()
/** Starts anywhere, so a command after a reload is never mistaken for one an editor already did. */
let commandSeq = Math.floor(Math.random() * 1e9)

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)

    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

async function statOf(
  $: EngineInterface,
  path: string,
): Promise<{ mtimeMs: number; size: number; kind: string } | undefined> {
  try {
    const s = await $.fs.stat(path)

    return { mtimeMs: s.mtimeMs, size: s.size, kind: s.kind }
  } catch {
    return undefined
  }
}

/** git, kept from what a status would otherwise run or write: no fsmonitor, no index rewrite. */
const git = (dir: string, ...args: string[]) => [
  'git',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-C',
  dir,
  ...args,
]

/** The file's text at git HEAD: '' when git does not track it, null outside a repository. */
async function headOf($: EngineInterface, path: string): Promise<string | null> {
  const at = path.lastIndexOf('/')
  const dir = at > 0 ? path.slice(0, at) : '/'
  try {
    const inside = await $.process.run(git(dir, 'rev-parse', '--is-inside-work-tree'))
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return null
    // cat-file prints the blob as stored: no textconv or other filter the repository's config could name runs.
    const shown = await $.process.run(git(dir, 'cat-file', 'blob', `HEAD:./${path.slice(at + 1)}`))

    return shown.exitCode === 0 && !shown.isStdoutTruncated ? shown.stdout : ''
  } catch {
    return null
  }
}

/** Each changed or untracked file of the repository `dir` is in, by absolute path, with its two status letters. */
async function gitChanges($: EngineInterface, dir: string): Promise<Map<string, string> | undefined> {
  try {
    const top = await $.process.run(git(dir, 'rev-parse', '--show-toplevel'), { timeoutMs: 5000 })
    if (top.exitCode !== 0) return undefined
    const root = top.stdout.trim()
    const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules']
    const status = await $.process.run(git(dir, ...args), { timeoutMs: 10_000 })
    if (status.exitCode !== 0 || status.isStdoutTruncated) return undefined
    const out = new Map<string, string>()
    for (const entry of status.stdout.split('\0')) {
      if (entry.length > 3) out.set(`${root}/${entry.slice(3)}`, entry.slice(0, 2))
    }

    return out.size > MAX_SHELL_FILES ? undefined : out
  } catch {
    return undefined
  }
}

/** A file's text, unless it is past MAX_SHELL_BYTES or binary: not worth a diff. */
async function shellText($: EngineInterface, path: string): Promise<string | undefined> {
  const stat = await statOf($, path)
  if (!stat || stat.kind !== 'file' || stat.size > MAX_SHELL_BYTES) return undefined
  const text = await readText($, path)

  return text === undefined || text.includes('\0') ? undefined : text
}

type ShellBefore = {
  /** What git called changed; undefined outside a repository, or when git could not be asked. */
  changes?: Map<string, string>
  /** Files already changed before the command and not on the list: their text then. */
  texts: Map<string, string>
  /** The files the command names, not on the list: their text then, or undefined when there was none. */
  named: Map<string, string | undefined>
}

/** `a/./b/../c` as `a/c`; `base` absolute. */
function joinPath(base: string, rel: string): string {
  const out: string[] = []
  for (const part of `${base}/${rel}`.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }

  return `/${out.join('/')}`
}

/**
 * The files a shell command names, by absolute path: the words that look like
 * paths, from the working folder and from each folder the command goes to,
 * with `~` and the variables the command sets itself filled in. A file git
 * ignores, or one outside the repository, shows only this way.
 */
async function namedPaths($: EngineInterface, command: string): Promise<string[]> {
  const home = await $.env.get('HOME').catch(() => undefined)
  const vars = new Map<string, string>()
  for (const [, name, , value] of command.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=(["']?)([^\s"';&|()]+)\2/g)) {
    vars.set(name!, value!)
  }
  const fill = (word: string) => word.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (all, name: string) => vars.get(name) ?? all)
  const absolute = (word: string) =>
    word.startsWith('/')
      ? joinPath('/', word)
      : word.startsWith('~/') && home
        ? joinPath(home, word.slice(2))
        : undefined
  const bases = [cwd]
  for (const [, dir] of command.matchAll(/(?:^|[\s;&|(])cd\s+["']?([^\s"';&|()]+)/g)) {
    const at = absolute(fill(dir!)) ?? joinPath(cwd, fill(dir!))
    if (!bases.includes(at)) bases.push(at)
  }
  const out = new Set<string>()
  for (const raw of command.match(/[\w@%+=:,./~${}-]+/g) ?? []) {
    const word = fill(raw).replace(/[:,]+$/, '')
    if (!/[./]/.test(word) || word.includes('$') || word.includes('://') || word.startsWith('-')) continue
    if (word.length > 1024 || /^[.~/]+$/.test(word)) continue
    const at = absolute(word)
    for (const path of at ? [at] : word.startsWith('~') ? [] : bases.map(b => joinPath(b, word))) {
      if (!path.includes('/.git/')) out.add(path)
    }
    if (out.size >= MAX_NAMED) break
  }

  return [...out].slice(0, MAX_NAMED)
}

/** Before a shell command: what git calls changed, and the text of those files and of the files it names. */
async function shellBefore($: EngineInterface, command: string): Promise<ShellBefore> {
  if (!cwd) cwd = await $.session.cwd()
  const changes = await gitChanges($, cwd)
  const listed = new Set((await read($, files)).map(f => f.path))
  const texts = new Map<string, string>()
  let bytes = 0
  for (const path of changes?.keys() ?? []) {
    if (listed.has(path) || bytes > MAX_SHELL_TOTAL) continue
    const text = await shellText($, path)
    if (text === undefined) continue
    texts.set(path, text)
    bytes += text.length
  }
  const named = new Map<string, string | undefined>()
  for (const path of await namedPaths($, command).catch(() => [])) {
    if (listed.has(path) || changes?.has(path)) continue
    const stat = await statOf($, path)
    // A folder, or a file too large or binary to show, is no file to follow.
    if (stat && (stat.kind !== 'file' || stat.size > MAX_SHELL_BYTES)) continue
    const text = stat ? await shellText($, path) : undefined
    if (stat && (text === undefined || bytes > MAX_SHELL_TOTAL)) continue
    named.set(path, text)
    bytes += text?.length ?? 0
  }

  return { changes, texts, named }
}

/**
 * After a shell command: each file it changed goes on the list. A file clean
 * before it was as HEAD has it; an untracked one is new; one changed already
 * is compared with its text before the command.
 */
async function shellAfter($: EngineInterface, before: ShellBefore): Promise<void> {
  const changes = before.changes && (await gitChanges($, cwd))
  for (const [path, status] of changes ?? []) {
    const listed = new Set((await read($, files)).map(f => f.path))
    if (listed.has(path) || status.includes('D')) continue
    const was = before.changes!.get(path)
    if (was !== undefined && !before.texts.has(path)) continue
    const after = await shellText($, path)
    if (after === undefined) continue
    const base = was !== undefined ? before.texts.get(path)! : status === '??' ? '' : await headOf($, path)
    if (base === null || base === after) continue
    await record($, path, base, after, was === undefined && base === '')
  }
  // The files it names, git or no git: a file it made is new, one it changed is compared with its text before.
  for (const [path, was] of before.named) {
    if ((await read($, files)).some(f => f.path === path)) continue
    const after = await shellText($, path)
    if (after === undefined || after === was) continue
    await record($, path, was ?? '', after, was === undefined)
  }
}

async function refreshHeads($: EngineInterface, only?: string): Promise<void> {
  for (const f of await read($, files)) {
    if (only !== undefined && f.path !== only) continue
    const head = await headOf($, f.path)
    if (head !== f.head) await patchFile($, f.path, x => ({ ...x, head }))
  }
}

async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  // Not placed (no room for it): the band above the prompt stands in for it.
  await update($, isPaneOpen, () => opened.isPlaced)

  return opened
}

const patchFile = ($: EngineInterface, path: string, fn: (f: TrackedFile) => TrackedFile) =>
  update($, files, list => list.map(f => (f.path === path ? fn(f) : f)))

/** Makes the file's editor take its text afresh: the draft if one is left, else the disk. */
const reload = ($: EngineInterface, path: string) =>
  patchFile($, path, f => ({ ...f, rev: f.rev + 1, conflict: false }))

const sendCommand = ($: EngineInterface, path: string, kind: EditorCommand['kind']) =>
  update($, commands, c => ({ ...c, [path]: { seq: ++commandSeq, kind } }))

// Claude's edits: remember the text before the first one, and before the first one of each turn.
async function track(
  $: EngineInterface,
  path: string,
  run: () => Promise<{ deny?: string; isError?: true }>,
): Promise<void> {
  const turn = await read($, turnId)
  const known = (await read($, files)).find(f => f.path === path)
  const before = known && known.turnId === turn ? undefined : await readText($, path)
  const ran = await run()
  if (ran.deny !== undefined || ran.isError) return
  const after = await readText($, path)
  if (after !== undefined) await record($, path, before, after)
}

/** Runs a file tool's call once, whatever keeping track of it around the call does. */
async function tracked<R extends { deny?: string; isError?: true }>(
  $: EngineInterface,
  path: string,
  next: () => Promise<R>,
): Promise<R> {
  let ran: R | undefined
  try {
    await track($, path, async () => (ran = await next()))
  } catch {
    // Keeping track is a courtesy: the call itself stands, and runs once.
  }

  return ran ?? next()
}

/**
 * Puts a change on the list: `after` is the file's text now, `before` its text
 * before the change, or undefined for a file already listed in this turn.
 */
async function record(
  $: EngineInterface,
  path: string,
  before: string | undefined,
  after: string,
  isNew = before === undefined,
): Promise<void> {
  const turn = await read($, turnId)
  const known = (await read($, files)).find(f => f.path === path)
  const stat = (await statOf($, path)) ?? { mtimeMs: 0, size: 0 }
  if (!cwd) cwd = await $.session.cwd()

  const hasDraft = (await read($, drafts))[path] !== undefined
  let id = 0
  if (!known) {
    id = await read($, nextId)
    await update($, nextId, n => n + 1)
  }
  await update($, files, list => {
    const old = list.find(f => f.path === path)
    const rest = list.filter(f => f.path !== path)
    const file: TrackedFile = old
      ? {
          ...old,
          ...stat,
          disk: after,
          rev: old.rev + 1,
          isDeleted: false,
          conflict: old.conflict || (hasDraft && after !== old.disk),
          ...(old.turnId === turn ? {} : { turnBase: before ?? old.disk, turnId: turn }),
        }
      : {
          id,
          path,
          display: printable(relative(path, cwd)),
          base: before ?? '',
          disk: after,
          rev: 1,
          isNew,
          conflict: false,
          isDeleted: false,
          isExpanded: false,
          turnBase: before ?? '',
          turnId: turn,
          ...stat,
        }

    return [file, ...rest]
  })
  if (!known && (await read($, baseMode)) === 'head') await refreshHeads($, path)
}

// Changes made outside the pane (another editor, git, a script): take them in.
async function poll($: EngineInterface): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    for (const f of await read($, files)) {
      if (writing.has(f.path)) continue
      const stat = await statOf($, f.path)
      if (!stat) {
        if (!f.isDeleted) await patchFile($, f.path, x => ({ ...x, isDeleted: true }))
        continue
      }
      if (stat.mtimeMs === f.mtimeMs && stat.size === f.size && !f.isDeleted) continue
      const text = await readText($, f.path)
      if (text === undefined || writing.has(f.path)) continue
      if (text === f.disk) {
        await patchFile($, f.path, x => ({ ...x, ...stat, isDeleted: false }))
        continue
      }
      const hasDraft = (await read($, drafts))[f.path] !== undefined
      if (!hasDraft && text === f.base) {
        // Changed back to how it was before Claude: nothing left to show.
        await update($, files, list => list.filter(x => x.path !== f.path))
        continue
      }
      await patchFile($, f.path, x => ({
        ...x,
        ...stat,
        disk: text,
        isDeleted: false,
        rev: hasDraft ? x.rev : x.rev + 1,
        conflict: hasDraft,
      }))
    }
    // A commit moves HEAD without touching the files.
    if (++polls % HEAD_POLLS === 0 && (await read($, baseMode)) === 'head') await refreshHeads($)
    if (polls % SAVE_POLLS === 0) await persist($).catch(() => {})
  } finally {
    isPolling = false
  }
}

// Saving the list, so a resumed session finds it again.

/** The versions of every value saved, as one string. */
async function stamp($: EngineInterface): Promise<string> {
  const all = await Promise.all([
    $.state.get({ plugin: 'editable-diff', key: 'files' }),
    $.state.get({ plugin: 'editable-diff', key: 'drafts' }),
    $.state.get({ plugin: 'editable-diff', key: 'nextId' }),
    $.state.get({ plugin: 'editable-diff', key: 'active' }),
    $.state.get({ plugin: 'editable-diff', key: 'baseMode' }),
    $.state.get({ plugin: 'editable-diff', key: 'turnId' }),
    $.state.get({ plugin: 'editable-diff', key: 'isSplit' }),
    $.state.get({ plugin: 'editable-diff', key: 'ignoreWhitespace' }),
    $.state.get({ plugin: 'editable-diff', key: 'viewed' }),
    $.state.get({ plugin: 'editable-diff', key: 'comments' }),
  ])

  return all.map(x => x.version).join(',')
}

/** A file as the store keeps it: its text on disk only as a fingerprint, the turn's base only when not the session's. */
function toSaved(f: TrackedFile): SavedFile {
  const { disk, head: _head, rev: _rev, conflict: _conflict, mtimeMs: _mtime, size: _size, ...rest } = f

  return { ...rest, turnBase: f.turnBase === f.base ? undefined : f.turnBase, diskHash: fingerprint(disk) }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every(x => typeof x === 'string')

function asIndex(v: unknown): SavedIndex {
  if (!isRecord(v)) return {}
  const out: SavedIndex = {}
  for (const [id, e] of Object.entries(v)) {
    if (isRecord(e) && typeof e.savedAt === 'number' && typeof e.size === 'number') {
      out[id] = { savedAt: e.savedAt, size: e.size }
    }
  }

  return out
}

/** The store's value as a saved session, or undefined when it is not one: the store is a file anyone can edit. */
function asSaved(v: unknown): SavedSession | undefined {
  if (!isRecord(v) || v.version !== 1 || !Array.isArray(v.files)) return undefined
  if (!isStrings(v.drafts) || !isStrings(v.viewed) || !Array.isArray(v.comments)) return undefined
  const isFile = (f: unknown): f is SavedFile =>
    isRecord(f) &&
    typeof f.id === 'number' &&
    typeof f.path === 'string' &&
    f.path.startsWith('/') &&
    typeof f.display === 'string' &&
    typeof f.base === 'string' &&
    typeof f.diskHash === 'string' &&
    (f.turnBase === undefined || typeof f.turnBase === 'string')
  const isComment = (c: unknown): c is ReviewComment =>
    isRecord(c) &&
    typeof c.id === 'number' &&
    typeof c.path === 'string' &&
    typeof c.display === 'string' &&
    typeof c.from === 'number' &&
    typeof c.to === 'number' &&
    typeof c.quote === 'string' &&
    typeof c.text === 'string'
  const mode = MODES.some(m => m.mode === v.baseMode) ? (v.baseMode as BaseMode) : 'session'

  return {
    version: 1,
    savedAt: typeof v.savedAt === 'number' ? v.savedAt : 0,
    files: v.files.filter(isFile),
    dropped: typeof v.dropped === 'number' ? v.dropped : 0,
    drafts: v.drafts,
    nextId: typeof v.nextId === 'number' ? v.nextId : 1,
    active: typeof v.active === 'string' ? v.active : '',
    baseMode: mode,
    turnId: typeof v.turnId === 'string' ? v.turnId : '',
    isSplit: v.isSplit === true,
    ignoreWhitespace: v.ignoreWhitespace === true,
    viewed: v.viewed,
    comments: v.comments.filter(isComment),
  }
}

/** Saves the session's list to the store when it changed since the last save; an empty list drops it. */
async function persist($: EngineInterface): Promise<void> {
  if (!sessionId) return
  const now = await stamp($)
  if (now === savedStamp) return
  savedStamp = now
  const key = `session:${sessionId}`
  const index = asIndex(await $.store.get(INDEX))
  const list = await read($, files)
  if (list.length === 0) {
    if (index[sessionId]) {
      await $.store.delete(key)
      await $.store.set(INDEX, without(index, sessionId))
    }
    return
  }

  const unsaved = await read($, drafts)
  const notes = await read($, comments)
  const marks = await read($, viewed)
  const keep = (paths: ReadonlySet<string>): SavedSession => ({
    version: 1,
    savedAt: Date.now(),
    files: list.filter(f => paths.has(f.path)).map(toSaved),
    dropped: list.length - paths.size,
    drafts: Object.fromEntries(Object.entries(unsaved).filter(([p]) => paths.has(p))),
    nextId: 0,
    active: '',
    baseMode: 'session',
    turnId: '',
    isSplit: false,
    ignoreWhitespace: false,
    viewed: Object.fromEntries(Object.entries(marks).filter(([p]) => paths.has(p))),
    comments: notes.filter(c => paths.has(c.path)),
  })
  // The largest files are left out until the rest fits.
  const bySize = list
    .map(f => ({ path: f.path, size: f.base.length + (f.turnBase?.length ?? 0) + (unsaved[f.path]?.length ?? 0) }))
    .sort((a, b) => a.size - b.size)
  const paths = new Set(bySize.map(x => x.path))
  let saved = keep(paths)
  let text = JSON.stringify(saved)
  while (text.length > MAX_SAVED && paths.size > 0) {
    paths.delete(bySize.pop()!.path)
    saved = keep(paths)
    text = JSON.stringify(saved)
  }
  saved = {
    ...saved,
    nextId: await read($, nextId),
    active: await read($, active),
    baseMode: await read($, baseMode),
    turnId: await read($, turnId),
    isSplit: await read($, isSplit),
    ignoreWhitespace: await read($, ignoreWhitespace),
  }

  // The newest other sessions stay while there is room; the rest go.
  const next: SavedIndex = {}
  let total = text.length
  const others = Object.entries(index)
    .filter(([id]) => id !== sessionId)
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
  for (const [id, e] of others) {
    if (Object.keys(next).length + 1 < MAX_SESSIONS && total + e.size <= MAX_STORE) {
      next[id] = e
      total += e.size
    } else await $.store.delete(`session:${id}`)
  }
  await $.store.set(key, saved)
  await $.store.set(INDEX, { ...next, [sessionId]: { savedAt: saved.savedAt, size: text.length } })
}

/** Takes back the list this session saved before it was last closed, with each file read again from disk. */
async function restore($: EngineInterface): Promise<void> {
  const saved = asSaved(await $.store.get(`session:${sessionId}`))
  if (!saved || saved.files.length === 0) return
  if (!cwd) cwd = await $.session.cwd()
  const list: TrackedFile[] = []
  for (const s of saved.files) {
    const text = await readText($, s.path)
    const draft = saved.drafts[s.path]
    // Changed back to how it was before Claude while the session was closed: nothing left to show.
    if (text === s.base && draft === undefined) continue
    const { diskHash, ...rest } = s
    list.push({
      ...rest,
      turnBase: s.turnBase ?? s.base,
      disk: text ?? '',
      rev: 1,
      conflict: draft !== undefined && text !== undefined && fingerprint(text) !== diskHash,
      isDeleted: text === undefined,
      ...((await statOf($, s.path)) ?? { mtimeMs: 0, size: 0 }),
    })
  }
  const paths = new Set(list.map(f => f.path))
  const kept = <T,>(d: Record<string, T>) => Object.fromEntries(Object.entries(d).filter(([p]) => paths.has(p)))
  await update($, files, () => list)
  await update($, drafts, () => kept(saved.drafts))
  await update($, nextId, n => Math.max(n, saved.nextId, ...list.map(f => f.id + 1)))
  await update($, active, () => (paths.has(saved.active) ? saved.active : ''))
  await update($, baseMode, () => saved.baseMode)
  await update($, turnId, t => t || saved.turnId)
  await update($, isSplit, () => saved.isSplit)
  await update($, ignoreWhitespace, () => saved.ignoreWhitespace)
  await update($, viewed, () => kept(saved.viewed))
  await update($, comments, () => saved.comments.filter(c => paths.has(c.path)))
  if (saved.baseMode === 'head') await refreshHeads($)
  if (saved.dropped > 0) {
    $.ui.toast(`${fileCount(saved.dropped)} of the last session were too large to keep, and are not listed`)
  }
  savedStamp = await stamp($)
}

async function save($: EngineInterface, path: string, text: string): Promise<void> {
  const file = (await read($, files)).find(f => f.path === path)
  if (!file) return
  writing.add(path)
  try {
    await $.fs.write(path, text)
  } catch (error) {
    $.ui.toast(`Could not save ${file.display}: ${error instanceof Error ? error.message : String(error)}`)
    return
  } finally {
    writing.delete(path)
  }
  const stat = (await statOf($, path)) ?? { mtimeMs: file.mtimeMs, size: file.size }
  await update($, drafts, d => without(d, path))
  await patchFile($, path, f => ({ ...f, ...stat, disk: text, conflict: false, isDeleted: false }))
  $.ui.toast(`Saved ${file.display}`)
  try {
    await $.session.append({
      message: {
        type: 'user',
        content: [
          {
            type: 'text',
            text: `[editable-diff] The user saved their own edits to ${path}. Read the file again before editing it next.`,
          },
        ],
      },
    })
  } catch {
    // The note is a courtesy to the model; the save already stands.
  }
}

/** Forgets every file, unsaved edit and comment; the files on disk stay as they are. */
async function clearAll($: EngineInterface): Promise<void> {
  await update($, files, () => [])
  await update($, drafts, () => ({}))
  await update($, isConfirmingClear, () => false)
  await update($, seen, () => ({}))
  await update($, active, () => '')
  await update($, viewed, () => ({}))
  await update($, comments, () => [])
  await update($, composing, () => null)
  await update($, commands, () => ({}))
  await update($, windows, () => ({}))
}

/** Clears at once, or asks first when there are unsaved edits to lose. */
async function askClear($: EngineInterface): Promise<void> {
  if (Object.keys(await read($, drafts)).length > 0) await update($, isConfirmingClear, () => true)
  else await clearAll($)
}

/** The files in the order the list shows them. */
const sorted = (list: readonly TrackedFile[]) => list.slice().sort((a, b) => a.display.localeCompare(b.display))

const textNow = async ($: EngineInterface, f: TrackedFile) => (await read($, drafts))[f.path] ?? f.disk

const isViewedNow = async ($: EngineInterface, f: TrackedFile) =>
  (await read($, viewed))[f.path] === fingerprint(await textNow($, f))

/** Past the last change of a file (or before the first): on to the next file not marked viewed. */
async function moveFile($: EngineInterface, path: string, dir: 1 | -1): Promise<void> {
  const order = sorted(await read($, files))
  const at = order.find(f => f.path === path)
  const kept = (await read($, windows))[path]
  if (at && kept) {
    // A file by parts: first the part with its next change.
    const mode = await read($, baseMode)
    const base = baseOf(at, mode, await read($, turnId))
    const text = await textNow($, at)
    const w = windowOf(at, text, base, mode, kept)
    const next = w && windowAtChange(base, text, w, dir)
    if (next) {
      await update($, windows, ws => ({ ...ws, [path]: next }))
      await sendCommand($, path, dir > 0 ? 'first' : 'last')
      return
    }
  }
  for (let n = order.findIndex(f => f.path === path) + dir; n >= 0 && n < order.length; n += dir) {
    const f = order[n]!
    if (await isViewedNow($, f)) continue
    await update($, active, () => f.path)
    await sendCommand($, f.path, dir > 0 ? 'first' : 'last')
    return
  }
  $.ui.toast(dir > 0 ? 'No more changes after this one' : 'No changes before this one')
}

async function startComment($: EngineInterface, path: string, sel?: [number, number]): Promise<void> {
  const [from, to] = sel ?? selOf.get(path) ?? [1, 1]
  await update($, active, () => path)
  await update($, composing, () => ({ path, from, to }))
  void $.ui.focus({ requestId: PANE, key: 'comment-input' }).catch(() => {})
}

async function addComment($: EngineInterface, text: string): Promise<void> {
  const at = await read($, composing)
  await update($, composing, () => null)
  const f = (await read($, files)).find(x => x.path === at?.path)
  if (!at || !f || !text.trim()) return
  const quote = splitLines(await textNow($, f))
    .slice(at.from - 1, at.to)
    .join('\n')
  const id = await read($, nextId)
  await update($, nextId, n => n + 1)
  const comment: ReviewComment = { id, path: f.path, display: f.display, from: at.from, to: at.to, quote, text }
  await update($, comments, list => [...list, comment])
}

/** The comments as one message: each with the lines it is about, quoted. */
function reviewText(list: readonly ReviewComment[]): string {
  const parts = list.map((c, n) => {
    const lines = c.quote.split('\n')
    const quote = lines.slice(0, QUOTE_LINES).join('\n') + (lines.length > QUOTE_LINES ? '\n…' : '')
    // A fence longer than any run of backticks in the quote: the file's text cannot close it.
    const fence = '`'.repeat(Math.max(3, ...(quote.match(/`+/g) ?? []).map(run => run.length + 1)))

    return `${n + 1}. ${c.display}, ${lineRange(c.from, c.to)}:\n${fence}${languageOf(c.path) ?? ''}\n${quote}\n${fence}\n${c.text.trim()}`
  })

  return `Please address my review comments on your changes:\n\n${parts.join('\n\n')}`
}

async function sendComments($: EngineInterface, how: 'submit' | 'fill'): Promise<void> {
  const list = await read($, comments)
  if (!list.length) return
  const text = reviewText(list)
  try {
    if (how === 'fill') {
      const filled = await $.prompt.fill({ text, mode: 'append' })
      if (!filled.isFilled) {
        $.ui.toast('The prompt box is busy: try again in a moment')
        return
      }
    } else await $.prompt.submit({ text, asUser: true })
  } catch (error) {
    $.ui.toast(`Could not send the comments: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  await update($, comments, () => [])
}

/**
 * Opens the file at the line in the first editor found: VS Code, Cursor, Zed,
 * Sublime, then macOS's text editor. Never the file's default app: for a script
 * or an app bundle that would run it.
 */
async function openInEditor($: EngineInterface, path: string, line: number): Promise<void> {
  const at = `${path}:${line}`
  const tries = [
    ['code', '-g', at],
    ['cursor', '-g', at],
    ['zed', at],
    ['subl', at],
    ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', '-g', at],
    ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor', '-g', at],
    ['open', '-t', path],
  ]
  for (const argv of tries) {
    try {
      if ((await $.process.run(argv, { timeoutMs: 10_000 })).exitCode === 0) return
    } catch {
      // Not installed: try the next one.
    }
  }
  $.ui.toast('Could not find an editor to open the file in')
}

// What draws nothing of a plugin's: no node, an empty string, the engine's
// own drawing (`{ type: 'engine' }`, empty unless a survey holds the band), or
// a Box or Text holding only such. No gap goes above that.
const isBlank = (node: unknown): boolean => {
  if (node === undefined || node === null || node === false) return true
  if (typeof node === 'string') return node.trim() === ''
  if (typeof node !== 'object') return false
  const { type, children } = node as { type?: unknown; children?: unknown[] }
  if (type === 'engine') return true

  return (type === 'Box' || type === 'Text') && (children ?? []).every(isBlank)
}

// On or off: `enabled` in $.store for every chat (on unless turned off), and
// `chat:<session id>` set to false for a chat turned off alone. The band and
// the panel show where it is on everywhere and not turned off in that chat;
// Claude's edits are tracked either way, so turning it on shows them all.
const chatKey = async ($: EngineInterface) => `chat:${await $.session.id()}`

const isShown = async ($: EngineInterface) => (await read($, isEnabled)) && (await read($, isChatEnabled))

const loadSwitches = async ($: EngineInterface) => {
  const everywhere = (await $.store.get('enabled').catch(() => undefined)) !== false
  const here =
    (await chatKey($)
      .then(key => $.store.get(key))
      .catch(() => undefined)) !== false
  await update($, isEnabled, () => everywhere)
  await update($, isChatEnabled, () => here)

  return everywhere && here
}

const hide = async ($: EngineInterface) => {
  await update($, isConfirmingClear, () => false)
  if (await read($, isPaneOpen)) {
    await $.ui.close({ id: PANE }).catch(() => {})
    await update($, isPaneOpen, () => false)
  }
}

type Switch = 'diff-on' | 'diff-off' | 'diff-chat-on' | 'diff-chat-off'

const SWITCHES: { name: Switch; description: string }[] = [
  { name: 'diff-on', description: "Show Claude's edits above the prompt in every chat" },
  { name: 'diff-off', description: "Hide Claude's edits in every chat" },
  { name: 'diff-chat-on', description: "Show Claude's edits in this chat" },
  { name: 'diff-chat-off', description: "Hide Claude's edits in this chat only" },
]

const runSwitch = async ($: EngineInterface, name: Switch) => {
  const key = await chatKey($)
  if (name === 'diff-on') {
    await $.store.set('enabled', true)
    await $.store.delete(key)
    await loadSwitches($)

    return 'Editable diff is on in every chat, except chats turned off with /diff-chat-off.'
  }
  if (name === 'diff-off') {
    await $.store.set('enabled', false)
    await loadSwitches($)
    await hide($)

    return 'Editable diff is off in every chat. /diff-on turns it back on.'
  }
  if (name === 'diff-chat-on') {
    await $.store.delete(key)

    return (await loadSwitches($))
      ? 'Editable diff is on in this chat.'
      : 'Editable diff is off in every chat; /diff-on turns it on everywhere.'
  }
  await $.store.set(key, false)
  await loadSwitches($)
  await hide($)

  return 'Editable diff is off in this chat. /diff-chat-on turns it back on here.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = await $.session.cwd()
    const isUp = (await $.ui.panes()).some(p => p.id === PANE)
    await update($, isPaneOpen, () => isUp)
    await update($, seen, () => ({}))
    // A resumed session: its list as it was when it closed. A hot reload keeps the list as it is.
    sessionId = await $.session.id().catch(() => '')
    if (sessionId && (await read($, files)).length === 0) await restore($).catch(() => {})
    $.clock.every(POLL_MS, () => void poll($).catch(() => {}))
    for (const command of SWITCHES) await $.command.register({ ...command, immediate: true })
    await loadSwitches($)
    // Another chat's /diff-on or /diff-off reaches this one within seconds.
    $.clock.every(3000, () => void loadSwitches($).then(isOn => (isOn ? undefined : hide($))))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await persist($).catch(() => {})

    return next(e)
  })

  for (const { name } of SWITCHES) {
    on('command.run', { command: name }, async $ => ({ text: await runSwitch($, name) }))
  }

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, isPaneOpen, () => false)

    return next(e)
  })

  // A prompt starts a new "last turn" for the Last turn view.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '') await update($, turnId, () => e.turnId)

    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, ($, e, next) => tracked($, e.file_path, () => next(e)))
  on('tool.call', { tool: 'Write' }, ($, e, next) => tracked($, e.file_path, () => next(e)))
  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) => tracked($, e.notebook_path, () => next(e)))

  // A shell command's changes, as git sees them and in the files it names; one in the background finishes too late to tell.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.run_in_background) return next(e)
    const before = await shellBefore($, e.command).catch(() => undefined)
    const ran = await next(e)
    if (before) await shellAfter($, before).catch(() => {})

    return ran
  })

  // The wheel over the file list scrolls the list, when it has more files than it shows.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (!isOverList || e.origin.kind !== 'person' || !e.pointer || (await read($, files)).length <= ROWS) return next(e)
    await update($, listScroll, was => ({ seq: (was?.seq ?? 0) + 1, by: e.by }))

    return {}
  })

  // The surface could not draw an editor's rows: draw fewer of them, in a new instance.
  on('ui.fault', async ($, e, next) => {
    const id = /^file-(\d+)/.exec(e.element)?.[1]
    if (e.phase === 'render' && e.module.endsWith('editor.tsx') && id) {
      const key = `file-${id}`
      const was = (await read($, budgets))[key] ?? BUDGET
      const budget = Math.max(MIN_BUDGET, Math.floor(was / 2))
      if (budget < was) {
        await update($, budgets, b => ({ ...b, [key]: budget }))
        $.ui.invalidate('ui.render')
      }
    }

    return next(e)
  })

  // What the file list posted (a file picked) or an editor posted (its whole
  // text, the lines under its cursor and the counters of its actions).
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    if (isHover(e.data)) {
      isOverList = e.data.isOver
      return next(e)
    }
    if (isSelect(e.data)) {
      const path = e.data.select
      await update($, active, () => path)
      return next(e)
    }
    if (!isPost(e.data)) return next(e)
    const post = e.data
    const file = (await read($, files)).find(f => f.path === post.path)
    if (!file) return next(e)
    selOf.set(post.path, post.sel)
    const last = countersOf((await read($, seen))[post.instance] ?? {})
    const counters = countersOf(post)
    if (COUNTERS.some(k => counters[k] !== last[k])) {
      await update($, seen, s => ({ ...s, [post.instance]: counters }))
    }

    if (post.focusSeq > last.focusSeq) await update($, active, () => post.path)
    const draft = (await read($, drafts))[post.path]
    // A file by pieces or parts: the editor's text goes back in their place.
    let text: string | undefined = post.text
    let isDirty = post.isDirty
    const mode = await read($, baseMode)
    const base = baseOf(file, mode, await read($, turnId))
    const before = draft ?? file.disk
    const kept = (await read($, windows))[post.path]
    const w = windowOf(file, before, base, mode, kept)
    if (w) {
      text = undefined
      if (e.element === windowKey(file.id, w)) {
        const back = spliceBack(before, w, post.text, post.cuts)
        text = back.text
        isDirty = text !== file.disk
        let now = back.window
        if (post.expandSeq > last.expandSeq) {
          const wider = expandGap(base, text, now, post.expand, WINDOW_AT)
          if (wider) now = wider
          else $.ui.toast(`${file.display}: no room to show more lines here; open it in your editor`)
        }
        if (w !== kept || JSON.stringify(now.pieces) !== JSON.stringify(w.pieces)) {
          await update($, windows, ws => ({ ...ws, [post.path]: now }))
        }
      }
    }
    if (text !== undefined && (isDirty ? draft !== text : draft !== undefined)) {
      const now = text
      await update($, drafts, d => (isDirty ? { ...d, [post.path]: now } : without(d, post.path)))
    }
    const command = (await read($, commands))[post.path]
    if (command && command.seq === post.cmdSeq) await update($, commands, c => without(c, post.path))

    if (post.copySeq > last.copySeq && post.clip) {
      const copied = await $.ui.copy({ text: post.clip, surface: e.surface })
      if (!copied.isCopied) $.ui.toast('Could not copy to the clipboard')
    }
    if (post.saveSeq > last.saveSeq) {
      if (text !== undefined && isDirty) await save($, post.path, text)
      else $.ui.toast(`${file.display}: nothing to save`)
    }
    if (post.commentSeq > last.commentSeq) await startComment($, post.path, post.sel)
    if (post.edgeSeq > last.edgeSeq) await moveFile($, post.path, post.edge)
    if (post.revealSeq > last.revealSeq) {
      void $.ui.scroll({ to: { key: 'here' }, in: PANE, block: 'center' }).catch(() => {})
    }

    return next(e)
  })

  // Above the prompt while the pane is closed: open it again, or clear the list.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, files)
    if (e.props.hasSurvey || list.length === 0 || (await read($, isPaneOpen)) || !(await isShown($))) return next(e)
    const dirty = Object.keys(await read($, drafts)).length
    const { Box, Text, Button } = $.ui.resolve(e)
    // The band is one for every plugin: what the hooks beneath draw (another
    // mod's band) stays, and this line goes under it.
    const beneath = await next(e)
    const stacked = (line: RenderElement) => (
      <Box flexDirection="column" rowGap={isBlank(beneath) ? 0 : 'lg'}>
        {beneath}
        {line}
      </Box>
    )

    if (await read($, isConfirmingClear)) {
      return stacked(
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color="warning">Unsaved edits in {fileCount(dirty)} will be lost. Files on disk stay as they are.</Text>
          <Button key="band-clear-yes" label="Clear" variant="primary" onPress={() => clearAll($)} />
          <Button key="band-clear-no" label="Cancel" onPress={() => update($, isConfirmingClear, () => false)} />
        </Box>,
      )
    }

    return stacked(
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text>
          <Text color="claude">●</Text> <Text weight="semibold">Claude's edits</Text>
          <Text dimColor> · {fileCount(list.length)}</Text>
          {dirty > 0 ? <Text color="warning"> · {dirty} unsaved</Text> : ''}
        </Text>
        <Button key="open-pane" label="Open panel" variant="secondary" onPress={() => void openPane($)} />
        <Button key="band-clear" label="Clear these diffs" variant="secondary" onPress={() => askClear($)} />
      </Box>,
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, files)
    const unsaved = await read($, drafts)
    const confirming = await read($, isConfirmingClear)
    const picked = await read($, active)
    const mode = await read($, baseMode)
    const turn = await read($, turnId)
    const split = await read($, isSplit)
    const ws = await read($, ignoreWhitespace)
    const marks = await read($, viewed)
    const notes = await read($, comments)
    const writingOn = await read($, composing)
    const asked = await read($, commands)
    const budgetOf = await read($, budgets)
    const parts = await read($, windows)
    const wheel = await read($, listScroll)
    const isDark = await isDarkTheme($)
    const selected = list.find(f => f.path === picked) ?? list[0]
    const dirtyCount = list.filter(f => unsaved[f.path] !== undefined).length

    const saveAll = async () => {
      for (const [path, text] of Object.entries(await read($, drafts))) await save($, path, text)
    }
    const discard = (path: string) => async () => {
      await update($, drafts, d => without(d, path))
      await reload($, path)
    }
    const remove = (path: string) => async () => {
      await update($, files, l => l.filter(f => f.path !== path))
      await update($, drafts, d => without(d, path))
      await update($, windows, ws => without(ws, path))
    }
    const setMode = async (next: BaseMode) => {
      await update($, baseMode, () => next)
      if (next === 'head') await refreshHeads($)
    }

    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Without a surface module the files are buttons and the diff is read-only.
    // The terminal and the desktop app run surface modules; the mobile app draws neither them nor fields.
    const isEditing = e.surface === 'terminal' || e.surface === 'desktop'
    const Client = isEditing && 'Client' in elements ? elements.Client : undefined
    const Code = 'Code' in elements ? elements.Code : undefined
    const Input = isEditing && 'Input' in elements ? elements.Input : undefined
    const isApp = e.surface !== 'terminal'
    const tint = {
      neutral: isDark ? '#ffffff14' : '#0000000f',
      warning: '#d2992626',
      accent: '#388bfd26',
    }

    /** A short label on a tinted ground; in brackets on the terminal. */
    const chip = (key: string, text: string, color?: Color, ground = tint.neutral) =>
      isApp ? (
        <Box key={key} backgroundColor={ground} paddingX={1}>
          <Text color={color} tabular>
            {text}
          </Text>
        </Box>
      ) : (
        <Text key={key} color={color} dimColor={!color}>
          [{text}]
        </Text>
      )

    if (!selected) {
      return (
        <Box flexDirection="column" alignItems="center" paddingY={2}>
          <Text color="success">✓</Text>
          <Text weight="semibold">No changes yet</Text>
          <Text dimColor>Files Claude changes will show up here.</Text>
        </Box>
      )
    }

    const textOf = (f: TrackedFile) => unsaved[f.path] ?? f.disk
    const baseFor = (f: TrackedFile) => baseOf(f, mode, turn)
    const isViewed = (f: TrackedFile) => marks[f.path] === fingerprint(textOf(f))
    const stats = new Map(
      list.map(f => [
        f.path,
        countChanges(diffLines(splitLines(baseFor(f)), splitLines(textOf(f)), { ignoreWhitespace: ws })),
      ]),
    )
    const order = sorted(list)

    const toggleViewed = (f: TrackedFile) => async () => {
      if (isViewed(f)) {
        await update($, viewed, v => without(v, f.path))
        return
      }
      await update($, viewed, v => ({ ...v, [f.path]: fingerprint(textOf(f)) }))
      // On to the next file left to review, as a review goes.
      const at = order.indexOf(f)
      const next = [...order.slice(at + 1), ...order.slice(0, at)].find(x => !isViewed(x))
      if (next) await update($, active, () => next.path)
    }

    const toolbar = (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text weight="semibold">Changes</Text>
          {chip('count', String(list.length))}
          {dirtyCount > 0 ? chip('unsaved', `● ${dirtyCount} unsaved`, 'warning', tint.warning) : null}
        </Box>
        <Box flexDirection="row" gap={1}>
          {dirtyCount > 1 ? <Button key="save-all" label="Save all" variant="primary" onPress={saveAll} /> : null}
          <Button key="clear" label="Clear these diffs" variant="secondary" onPress={() => askClear($)} />
        </Box>
      </Box>
    )

    const options = (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap">
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text dimColor>Compare with</Text>
          {MODES.map(m => (
            <Button
              key={`base-${m.mode}`}
              label={m.label}
              variant={m.mode === mode ? 'primary' : 'secondary'}
              onPress={() => setMode(m.mode)}
            />
          ))}
        </Box>
        {Client ? (
          <Box flexDirection="row" gap={1}>
            <Button
              key="split"
              label={split ? 'Unified' : 'Split'}
              variant="secondary"
              onPress={() => update($, isSplit, x => !x)}
            />
            <Button
              key="whitespace"
              label={ws ? '✓ Ignore whitespace' : 'Ignore whitespace'}
              variant="secondary"
              onPress={() => update($, ignoreWhitespace, x => !x)}
            />
          </Box>
        ) : null}
      </Box>
    )

    const confirm = confirming ? (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text color="warning">
          Unsaved edits in {fileCount(dirtyCount)} will be lost. Files on disk stay as they are.
        </Text>
        <Button key="clear-yes" label="Clear" variant="primary" onPress={() => clearAll($)} />
        <Button key="clear-no" label="Cancel" onPress={() => update($, isConfirmingClear, () => false)} />
      </Box>
    ) : null

    const review = notes.length ? (
      <Box key="review" flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text weight="semibold">Review comments</Text>
            {chip('comment-count', String(notes.length), 'suggestion', tint.accent)}
          </Box>
          <Box flexDirection="row" gap={1}>
            <Button
              key="comments-send"
              label="Send to Claude"
              variant="primary"
              onPress={() => sendComments($, 'submit')}
            />
            <Button
              key="comments-fill"
              label="Put in prompt"
              variant="secondary"
              onPress={() => sendComments($, 'fill')}
            />
            <Button
              key="comments-clear"
              label="Discard"
              variant="secondary"
              onPress={() => update($, comments, () => [])}
            />
          </Box>
        </Box>
        {notes.map(c => (
          <Box key={`comment-${c.id}`} flexDirection="row" alignItems="center" gap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                <Text color="suggestion">
                  {c.display}:{c.from === c.to ? c.from : `${c.from}–${c.to}`}
                </Text>{' '}
                {c.text}
              </Text>
            </Box>
            <Button
              key={`uncomment-${c.id}`}
              label="×"
              onPress={() => update($, comments, l => l.filter(x => x.id !== c.id))}
            />
          </Box>
        ))}
      </Box>
    ) : null

    // The list, sorted by path as GitHub Desktop sorts it.
    const rows: FileRow[] = order.map(f => ({
      path: f.path,
      ...splitPath(f.display),
      status: f.isDeleted ? 'D' : f.isNew ? 'A' : 'M',
      ...stats.get(f.path)!,
      isDirty: unsaved[f.path] !== undefined,
      isViewed: isViewed(f),
    }))

    /** The part of the file its editor holds, when it goes by parts. */
    const partCache = new Map<string, FileWindow | undefined>()
    const partOf = (f: TrackedFile) => {
      if (!partCache.has(f.path)) partCache.set(f.path, windowOf(f, textOf(f), baseFor(f), mode, parts[f.path]))
      return partCache.get(f.path)
    }

    const editor = (f: TrackedFile) => {
      if (!Client) return null
      const whole = textOf(f)
      const wholeBase = baseFor(f)
      const w = partOf(f)
      const { text, base } = w ? slices(wholeBase, whole, w) : { text: whole, base: wholeBase }
      const key = w ? windowKey(f.id, w) : `file-${f.id}`
      const basePieces = w ? w.pieces.map(p => `${p.baseLine}+${p.baseLines}`).join(',') : ''
      const props = {
        file: f.path,
        text,
        patch: makePatch(base, text),
        rev: f.rev,
        baseKey: `${mode}:${fingerprint(wholeBase)}${w ? `:${basePieces}` : ''}`,
        // By pieces, whether the file has unsaved edits is told by the whole text.
        diskHash: w ? '' : fingerprint(f.disk),
        firstLine: w?.pieces[0]!.line ?? 0,
        firstBaseLine: w?.pieces[0]!.baseLine ?? 0,
        ...(w ? gapsOf(wholeBase, w) : { gaps: [], lead: 0, trail: 0 }),
        isPieces: w !== undefined && !w.isWhole,
        conflict: f.conflict,
        expanded: f.isExpanded,
        isSplit: split,
        ignoreWhitespace: ws,
        isFocused: f === selected,
        surface: e.surface,
        language: languageOf(f.path) ?? null,
        isDark,
        notes: notes.filter(c => c.path === f.path).map((c): [number, number] => [c.from, c.to]),
        command: asked[f.path] ?? null,
        budget: budgetOf[`file-${f.id}`] ?? BUDGET,
      }
      if (JSON.stringify(props).length > MAX_PROPS) {
        return f === selected ? (
          <Text key={`big-${f.id}`} dimColor>
            Too large to edit in the panel: open it in your editor.
          </Text>
        ) : null
      }

      // Files with unsaved edits stay mounted while hidden, so their undo history and cursor stay too.
      return (
        <Box key={`ed-${f.id}`} flexDirection="column" width="100%" display={f === selected ? 'flex' : 'none'}>
          <Client key={key} module="./editor.tsx" props={props} width="100%" />
        </Box>
      )
    }

    const f = selected
    const draft = unsaved[f.path]
    const isDirty = draft !== undefined
    const base = baseFor(f)
    const isFileViewed = isViewed(f)
    const { added, removed } = stats.get(f.path)!
    const { name, dir } = splitPath(f.display)

    // GitHub's five squares: the share of added and removed lines.
    const total = added + removed
    const green = total ? Math.round((5 * added) / total) : 0
    const red = total ? Math.min(5 - green, Math.round((5 * removed) / total)) : 0
    const squares = (
      <Text>
        <Text color="success">{'■'.repeat(green)}</Text>
        <Text color="error">{'■'.repeat(red)}</Text>
        <Text dimColor>{'■'.repeat(5 - green - red)}</Text>
      </Text>
    )

    const header = (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
          <Text wrap="truncate-start">
            {dir ? <Text dimColor>{dir}/</Text> : ''}
            <Text weight="semibold">{name}</Text>
          </Text>
          {f.isNew ? chip('new', 'new', 'success') : null}
          {isDirty ? chip('dirty', '● unsaved', 'warning', tint.warning) : null}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button
            key={`viewed-${f.id}`}
            label={isFileViewed ? '✓ Viewed' : 'Viewed'}
            variant="secondary"
            onPress={toggleViewed(f)}
          />
          {isDirty ? <Button key={`discard-${f.id}`} label="Discard my edits" onPress={discard(f.path)} /> : null}
          <Button
            key={`save-${f.id}`}
            label="Save"
            variant={isDirty ? 'primary' : 'secondary'}
            dimColor={!isDirty}
            onPress={() => (isDirty ? save($, f.path, draft) : $.ui.toast(`${f.display}: nothing to save`))}
          />
        </Box>
      </Box>
    )

    const canRevert = base !== textOf(f) && base !== ''
    const part = Client ? partOf(f) : undefined
    const movePart = (x: TrackedFile, dir: 1 | -1) => async () => {
      const w = partOf(x)
      const next = w && shiftWindow(baseFor(x), textOf(x), w, dir)
      if (next) await update($, windows, ws => ({ ...ws, [x.path]: next }))
    }
    const tools = (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap">
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text tabular>
            <Text color="success">+{added}</Text> <Text color="error">−{removed}</Text>
          </Text>
          {squares}
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {Client && !isFileViewed ? (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button
                key={`prev-${f.id}`}
                label="↑ Prev"
                variant="secondary"
                onPress={() => sendCommand($, f.path, 'prev')}
              />
              <Button
                key={`next-${f.id}`}
                label="↓ Next"
                variant="secondary"
                onPress={() => sendCommand($, f.path, 'next')}
              />
              <Button
                key={`find-${f.id}`}
                label="Find"
                variant="secondary"
                onPress={async () => {
                  await sendCommand($, f.path, 'find')
                  const w = partOf(f)
                  void $.ui.focus({ requestId: PANE, key: w ? windowKey(f.id, w) : `file-${f.id}` }).catch(() => {})
                }}
              />
              <Button
                key={`comment-${f.id}`}
                label="Comment"
                variant="secondary"
                onPress={() => startComment($, f.path)}
              />
            </Box>
          ) : null}
          {/* Hunks all in the editor need no parts; only too many of them, or the whole file, do. */}
          {part && (part.before || part.after) ? (
            <Box flexDirection="row" alignItems="center" gap={1}>
              <Text dimColor tabular>
                Lines {part.pieces[0]!.line + 1}–
                {part.pieces[part.pieces.length - 1]!.line + part.pieces[part.pieces.length - 1]!.lines} of{' '}
                {splitLines(textOf(f)).length}
              </Text>
              {part.before ? (
                <Button key={`earlier-${f.id}`} label="↑ Earlier part" variant="secondary" onPress={movePart(f, -1)} />
              ) : null}
              {part.after ? (
                <Button key={`later-${f.id}`} label="↓ Later part" variant="secondary" onPress={movePart(f, 1)} />
              ) : null}
            </Box>
          ) : null}
          <Button
            key={`expand-${f.id}`}
            label={f.isExpanded ? 'Changes only' : 'Whole file'}
            variant="secondary"
            onPress={() => patchFile($, f.path, x => ({ ...x, isExpanded: !x.isExpanded }))}
          />
          <Button
            key={`open-${f.id}`}
            label="Open in editor"
            variant="secondary"
            onPress={() => openInEditor($, f.path, selOf.get(f.path)?.[0] ?? 1)}
          />
          {canRevert ? (
            <Button
              key={`revert-${f.id}`}
              label={MODES.find(m => m.mode === mode)!.revert}
              variant="secondary"
              onPress={async () => {
                await update($, drafts, d => (base === f.disk ? without(d, f.path) : { ...d, [f.path]: base }))
                await reload($, f.path)
              }}
            />
          ) : null}
          <Button key={`remove-${f.id}`} label="Remove from list" variant="secondary" onPress={remove(f.path)} />
        </Box>
      </Box>
    )

    const composer =
      Input && writingOn && writingOn.path === f.path ? (
        <Box key="composer" flexDirection="row" alignItems="center" gap={1}>
          <Text color="suggestion">Comment on {lineRange(writingOn.from, writingOn.to)}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Input
              key="comment-input"
              autoFocus
              placeholder="What should Claude change here?"
              submitLabel="add"
              onSubmit={(value: string) => addComment($, value)}
            />
          </Box>
          <Button key="comment-cancel" label="Cancel" onPress={() => update($, composing, () => null)} />
        </Box>
      ) : null

    const plain =
      Client || !Code
        ? undefined
        : unifiedDiff(diffLines(splitLines(base), splitLines(textOf(f)), { ignoreWhitespace: ws }), MAX_PLAIN_DIFF)
    const plainDiff =
      plain && Code ? (
        <Box key="plain-diff" flexDirection="column" gap={1}>
          {plain.text ? (
            <Code key={`code-${f.id}`} source={plain.text} format="diff" path={f.path} />
          ) : (
            <Text dimColor>No changes against {MODES.find(m => m.mode === mode)!.label.toLowerCase()}.</Text>
          )}
          {plain.shown < plain.hunks ? (
            <Text dimColor>
              {plain.shown} of {plain.hunks} changes shown: the rest are in the terminal and the desktop app.
            </Text>
          ) : null}
        </Box>
      ) : null

    const notice = (text: string) => <Text color="warning">{text}</Text>
    const notices = (
      <>
        {f.conflict ? (
          <Box flexDirection="row" alignItems="center" gap={1} backgroundColor={isApp ? tint.warning : undefined}>
            <Text color="warning"> The file changed on disk while you had unsaved edits.</Text>
            <Button key={`take-${f.id}`} label="Take the disk version" onPress={discard(f.path)} />
            <Button
              key={`keep-${f.id}`}
              label="Keep mine"
              onPress={() => patchFile($, f.path, x => ({ ...x, conflict: false }))}
            />
          </Box>
        ) : null}
        {f.isDeleted ? notice('The file was deleted from disk. Save creates it again.') : null}
        {mode === 'head' && f.head === null
          ? notice('Not in a git repository: compared with the session start.')
          : null}
        {mode === 'turn' && f.turnId !== turn ? (
          <Text dimColor>Claude did not change this file in its last turn.</Text>
        ) : null}
      </>
    )

    const detail = (
      <Box
        key="detail"
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        borderStyle="round"
        borderColor="subtle"
        paddingX={1}
        gap={1}
      >
        {header}
        {tools}
        {notices}
        {composer}
        {isFileViewed ? (
          <Text dimColor>Marked as viewed. The diff shows again when the file changes, or press Viewed.</Text>
        ) : null}
        {Client ? (
          <Box flexDirection="column">
            {list
              .filter(x => (x === selected && !isFileViewed) || unsaved[x.path] !== undefined)
              .map(x => (x === selected && isFileViewed ? null : editor(x)))}
          </Box>
        ) : !isFileViewed ? (
          plainDiff
        ) : null}
      </Box>
    )

    const columns = e.props.bodyColumns
    const isWide = columns >= 90
    const sideWidth = Math.max(26, Math.min(44, Math.floor(columns * 0.28)))
    const viewedCount = rows.filter(r => r.isViewed).length
    // Where no surface module runs: the files as buttons.
    const plainList =
      !Client && list.length > 1 ? (
        <Box key="file-list" flexDirection="column" gap={1}>
          <Text dimColor weight="semibold">
            CHANGED FILES{viewedCount ? ` · ${viewedCount}/${rows.length} VIEWED` : ''}
          </Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {order.map((x, n) => (
              <Button
                key={`pick-${x.id}`}
                label={`${rows[n]!.isViewed ? '✓ ' : ''}${rows[n]!.name} +${rows[n]!.added} −${rows[n]!.removed}`}
                variant={x === f ? 'primary' : 'secondary'}
                onPress={() => update($, active, () => x.path)}
              />
            ))}
          </Box>
        </Box>
      ) : null
    const fileList =
      Client && (isWide || list.length > 1) ? (
        <Box
          key="file-list"
          flexDirection="column"
          borderStyle="round"
          borderColor="subtle"
          width={isWide ? sideWidth : '100%'}
          flexShrink={0}
          gap={1}
        >
          <Text dimColor weight="semibold">
            {' '}
            CHANGED FILES{viewedCount ? ` · ${viewedCount}/${rows.length} VIEWED` : ''}
          </Text>
          <Client
            key="files"
            module="./files.tsx"
            props={{ rows, selected: f.path, surface: e.surface, isDark, scroll: wheel }}
            width="100%"
          />
        </Box>
      ) : null

    return (
      <Box flexDirection="column" gap={1}>
        {toolbar}
        {options}
        {confirm}
        {review}
        <Box flexDirection={isWide && Client ? 'row' : 'column'} gap={1}>
          {fileList ?? plainList}
          {detail}
        </Box>
      </Box>
    )
  })
}

function without<T>(d: Record<string, T>, path: string): Record<string, T> {
  const { [path]: _, ...rest } = d

  return rest
}
