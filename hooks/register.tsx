import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { BaseMode, Counters, EditorCommand, EditorPost, FilesPost, ReviewComment, TrackedFile } from '../types'
import { countChanges, diffLines, fingerprint, makePatch, splitLines } from './diff'
import type { FileRow } from './files'
import { languageOf } from './highlight'

const PANE = 'editable-diff'
const TITLE = "Claude's edits"
/** A Client's props go whole or not at all; past this the file is shown, not edited. */
const MAX_PROPS = 95_000
/** How often files are checked for changes made outside the pane. */
const POLL_MS = 1000
/** How many polls between reads of git HEAD, while the diff is drawn against it. */
const HEAD_POLLS = 5
/** What an editor's rows may serialize to at first, and at least after the surface refused its drawings. */
const BUDGET = 50_000
const MIN_BUDGET = 5_000
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
const baseMode = atom({ plugin: 'editable-diff', key: 'baseMode' } as const, 'session')
const turnId = atom({ plugin: 'editable-diff', key: 'turnId' } as const, '')
const isSplit = atom({ plugin: 'editable-diff', key: 'isSplit' } as const, false)
const ignoreWhitespace = atom({ plugin: 'editable-diff', key: 'ignoreWhitespace' } as const, false)
const viewed = atom({ plugin: 'editable-diff', key: 'viewed' } as const, {})
const comments = atom({ plugin: 'editable-diff', key: 'comments' } as const, [])
const composing = atom({ plugin: 'editable-diff', key: 'composing' } as const, null)
const commands = atom({ plugin: 'editable-diff', key: 'commands' } as const, {})
const budgets = atom({ plugin: 'editable-diff', key: 'budgets' } as const, {})

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
    d.sel.every(n => typeof n === 'number')
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

function isSelect(data: unknown): data is FilesPost {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).select === 'string'
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

/** The session's folder, read at session start: paths under it are shown relative. */
let cwd = ''
/** Paths being written by a save right now: the poll leaves them alone. */
const writing = new Set<string>()
let isPolling = false
let polls = 0
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

async function statOf($: EngineInterface, path: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const s = await $.fs.stat(path)

    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return undefined
  }
}

/** The file's text at git HEAD: '' when git does not track it, null outside a repository. */
async function headOf($: EngineInterface, path: string): Promise<string | null> {
  const at = path.lastIndexOf('/')
  const dir = at > 0 ? path.slice(0, at) : '/'
  try {
    const inside = await $.process.run(['git', '-C', dir, 'rev-parse', '--is-inside-work-tree'])
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return null
    const shown = await $.process.run(['git', '-C', dir, 'show', `HEAD:./${path.slice(at + 1)}`])

    return shown.exitCode === 0 ? shown.stdout : ''
  } catch {
    return null
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
  if (after === undefined) return
  const stat = (await statOf($, path)) ?? { mtimeMs: 0, size: 0 }
  if (!cwd) cwd = await $.session.cwd()

  const hasDraft = (await read($, drafts))[path] !== undefined
  let wasEmpty = false
  let id = 0
  if (!known) {
    id = await read($, nextId)
    await update($, nextId, n => n + 1)
  }
  await update($, files, list => {
    wasEmpty = list.length === 0
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
          display: relative(path, cwd),
          base: before ?? '',
          disk: after,
          rev: 1,
          isNew: before === undefined,
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
  if (wasEmpty) void openPane($)
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
  } finally {
    isPolling = false
  }
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

    return `${n + 1}. ${c.display}, ${lineRange(c.from, c.to)}:\n\`\`\`${languageOf(c.path) ?? ''}\n${quote}\n\`\`\`\n${c.text.trim()}`
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

/** Opens the file at the line in the first editor found: VS Code, Cursor, Zed, Sublime, then the system's. */
async function openInEditor($: EngineInterface, path: string, line: number): Promise<void> {
  const at = `${path}:${line}`
  const tries = [
    ['code', '-g', at],
    ['cursor', '-g', at],
    ['zed', at],
    ['subl', at],
    ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', '-g', at],
    ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor', '-g', at],
    ['open', path],
    ['xdg-open', path],
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = await $.session.cwd()
    await $.command.register({
      name: 'editable-diff',
      description: "Open the panel with Claude's edits: diff, edit in place, save",
    })
    const isUp = (await $.ui.panes()).some(p => p.id === PANE)
    await update($, isPaneOpen, () => isUp)
    await update($, seen, () => ({}))
    $.clock.every(POLL_MS, () => void poll($).catch(() => {}))

    return next(e)
  })

  on('command.run', { command: 'editable-diff' }, async $ => {
    const { isPlaced } = await openPane($)

    return { text: isPlaced ? 'The edits panel is open.' : 'The edits panel opens once there is room for it.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, isPaneOpen, () => false)

    return next(e)
  })

  // A prompt starts a new "last turn" for the Last turn view.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '') await update($, turnId, () => e.turnId)

    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    let ran: Awaited<ReturnType<typeof next>> | undefined
    await track($, e.file_path, async () => (ran = await next(e)))

    return ran ?? next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    let ran: Awaited<ReturnType<typeof next>> | undefined
    await track($, e.file_path, async () => (ran = await next(e)))

    return ran ?? next(e)
  }).catch(($, e, next) => next(e))

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
    if (post.isDirty ? draft !== post.text : draft !== undefined) {
      await update($, drafts, d => (post.isDirty ? { ...d, [post.path]: post.text } : without(d, post.path)))
    }
    const command = (await read($, commands))[post.path]
    if (command && command.seq === post.cmdSeq) await update($, commands, c => without(c, post.path))

    if (post.copySeq > last.copySeq && post.clip) {
      const copied = await $.ui.copy({ text: post.clip, surface: e.surface })
      if (!copied.isCopied) $.ui.toast('Could not copy to the clipboard')
    }
    if (post.saveSeq > last.saveSeq) {
      if (post.isDirty) await save($, post.path, post.text)
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
    if (e.props.hasSurvey || list.length === 0 || (await read($, isPaneOpen))) return next(e)
    const dirty = Object.keys(await read($, drafts)).length
    const { Box, Text, Button } = $.ui.resolve(e)

    if (await read($, isConfirmingClear)) {
      return (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color="warning">Unsaved edits in {fileCount(dirty)} will be lost. Files on disk stay as they are.</Text>
          <Button key="band-clear-yes" label="Clear" variant="primary" onPress={() => clearAll($)} />
          <Button key="band-clear-no" label="Cancel" onPress={() => update($, isConfirmingClear, () => false)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text>
          <Text color="claude">●</Text> <Text weight="semibold">Claude's edits</Text>
          <Text dimColor> · {fileCount(list.length)}</Text>
          {dirty > 0 ? <Text color="warning"> · {dirty} unsaved</Text> : ''}
        </Text>
        <Button key="open-pane" label="Open panel" variant="secondary" onPress={() => void openPane($)} />
        <Button key="band-clear" label="Clear these diffs" variant="secondary" onPress={() => askClear($)} />
      </Box>
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
    }
    const setMode = async (next: BaseMode) => {
      await update($, baseMode, () => next)
      if (next === 'head') await refreshHeads($)
    }

    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The surfaces that run a surface module; another gets the list and the buttons alone.
    const Client = 'Client' in elements ? elements.Client : undefined
    const Input = 'Input' in elements ? elements.Input : undefined
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
          <Text dimColor>Files Claude changes with Edit or Write will show up here.</Text>
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

    const editor = (f: TrackedFile) => {
      if (!Client) return null
      const text = textOf(f)
      const base = baseFor(f)
      const key = `file-${f.id}`
      const props = {
        file: f.path,
        text,
        patch: makePatch(base, text),
        rev: f.rev,
        baseKey: `${mode}:${fingerprint(base)}`,
        diskHash: fingerprint(f.disk),
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
        budget: budgetOf[key] ?? BUDGET,
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
                  void $.ui.focus({ requestId: PANE, key: `file-${f.id}` }).catch(() => {})
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
        ) : null}
      </Box>
    )

    const columns = e.props.bodyColumns
    const isWide = columns >= 90
    const sideWidth = Math.max(26, Math.min(44, Math.floor(columns * 0.28)))
    const viewedCount = rows.filter(r => r.isViewed).length
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
            props={{ rows, selected: f.path, surface: e.surface, isDark }}
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
        <Box flexDirection={isWide ? 'row' : 'column'} gap={1}>
          {fileList}
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
