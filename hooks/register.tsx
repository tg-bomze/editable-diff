import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { Drafts, EditorPost, FilesPost, TrackedFile } from '../types'
import { countChanges, diffLines, fingerprint, makePatch, splitLines } from './diff'
import type { FileRow } from './files'
import { languageOf } from './highlight'

const PANE = 'editable-diff'
const TITLE = "Claude's edits"
/** A Client's props go whole or not at all; past this the file is shown, not edited. */
const MAX_PROPS = 95_000
/** How often files are checked for changes made outside the pane. */
const POLL_MS = 1000

const files = atom({ plugin: 'editable-diff', key: 'files' } as const, [])
const drafts = atom({ plugin: 'editable-diff', key: 'drafts' } as const, {})
const nextId = atom({ plugin: 'editable-diff', key: 'nextId' } as const, 1)
const isConfirmingClear = atom({ plugin: 'editable-diff', key: 'isConfirmingClear' } as const, false)
/** The last counters each editor instance posted, so a counter that moved acts once, reloads included. */
const seen = atom({ plugin: 'editable-diff', key: 'seen' } as const, {})
const active = atom({ plugin: 'editable-diff', key: 'active' } as const, '')
const isPaneOpen = atom({ plugin: 'editable-diff', key: 'isPaneOpen' } as const, false)

function isPost(data: unknown): data is EditorPost {
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>

  return (
    typeof d.path === 'string' &&
    typeof d.instance === 'string' &&
    typeof d.text === 'string' &&
    typeof d.isDirty === 'boolean' &&
    typeof d.saveSeq === 'number' &&
    typeof d.copySeq === 'number' &&
    typeof d.focusSeq === 'number' &&
    typeof d.clip === 'string'
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

/** The session's folder, read at session start: paths under it are shown relative. */
let cwd = ''
/** Paths being written by a save right now: the poll leaves them alone. */
const writing = new Set<string>()
let isPolling = false

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

// Claude's edits: remember the text before the first one, refresh after each.
async function track(
  $: EngineInterface,
  path: string,
  run: () => Promise<{ deny?: string; isError?: true }>,
): Promise<void> {
  const known = (await read($, files)).find(f => f.path === path)
  const before = known ? undefined : await readText($, path)
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
          ...stat,
        }

    return [file, ...rest]
  })
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

/** Forgets every file and every unsaved edit; the files on disk stay as they are. */
async function clearAll($: EngineInterface): Promise<void> {
  await update($, files, () => [])
  await update($, drafts, () => ({}))
  await update($, isConfirmingClear, () => false)
  await update($, seen, () => ({}))
  await update($, active, () => '')
}

/** Clears at once, or asks first when there are unsaved edits to lose. */
async function askClear($: EngineInterface): Promise<void> {
  if (Object.keys(await read($, drafts)).length > 0) await update($, isConfirmingClear, () => true)
  else await clearAll($)
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

  // What the file list posted (a file picked) or an editor posted (its whole
  // text and the counters of its actions).
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
    const last = (await read($, seen))[post.instance] ?? { saveSeq: 0, copySeq: 0, focusSeq: 0 }
    await update($, seen, s => ({
      ...s,
      [post.instance]: { saveSeq: post.saveSeq, copySeq: post.copySeq, focusSeq: post.focusSeq },
    }))

    if (post.focusSeq > last.focusSeq) await update($, active, () => post.path)
    await update($, drafts, d => (post.isDirty ? { ...d, [post.path]: post.text } : without(d, post.path)))

    if (post.copySeq > last.copySeq && post.clip) {
      const copied = await $.ui.copy({ text: post.clip, surface: e.surface })
      if (!copied.isCopied) $.ui.toast('Could not copy to the clipboard')
    }

    if (post.saveSeq > last.saveSeq) {
      if (post.isDirty) await save($, post.path, post.text)
      else $.ui.toast(`${file.display}: nothing to save`)
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
        <Button key="band-clear" label="Clear" variant="secondary" onPress={() => askClear($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, files)
    const unsaved = await read($, drafts)
    const confirming = await read($, isConfirmingClear)
    const picked = await read($, active)
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
    const revert = (path: string) => async () => {
      const f = (await read($, files)).find(x => x.path === path)
      if (!f) return
      await update($, drafts, d => (f.base === f.disk ? without(d, path) : { ...d, [path]: f.base }))
      await reload($, path)
    }
    const remove = (path: string) => async () => {
      await update($, files, l => l.filter(f => f.path !== path))
      await update($, drafts, d => without(d, path))
    }

    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The surfaces that run a surface module; another gets the list and the buttons alone.
    const Client = 'Client' in elements ? elements.Client : undefined
    const isApp = e.surface !== 'terminal'
    const tint = {
      neutral: isDark ? '#ffffff14' : '#0000000f',
      warning: '#d2992626',
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

    const toolbar = (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text weight="semibold">Changes</Text>
          {chip('count', String(list.length))}
          {dirtyCount > 0 ? chip('unsaved', `● ${dirtyCount} unsaved`, 'warning', tint.warning) : null}
        </Box>
        <Box flexDirection="row" gap={1}>
          {dirtyCount > 1 ? <Button key="save-all" label="Save all" variant="primary" onPress={saveAll} /> : null}
          <Button key="clear" label="Clear" variant="secondary" onPress={() => askClear($)} />
        </Box>
      </Box>
    )

    const confirm = confirming ? (
      <Box flexDirection="row" alignItems="center" gap={1} marginTop={1}>
        <Text color="warning">
          Unsaved edits in {fileCount(dirtyCount)} will be lost. Files on disk stay as they are.
        </Text>
        <Button key="clear-yes" label="Clear" variant="primary" onPress={() => clearAll($)} />
        <Button key="clear-no" label="Cancel" onPress={() => update($, isConfirmingClear, () => false)} />
      </Box>
    ) : null

    const textOf = (f: TrackedFile) => unsaved[f.path] ?? f.disk
    const stats = new Map(list.map(f => [f.path, countChanges(diffLines(splitLines(f.base), splitLines(textOf(f))))]))

    // The list, sorted by path as GitHub Desktop sorts it.
    const rows: FileRow[] = list
      .slice()
      .sort((a, b) => a.display.localeCompare(b.display))
      .map(f => ({
        path: f.path,
        ...splitPath(f.display),
        status: f.isDeleted ? 'D' : f.isNew ? 'A' : 'M',
        ...stats.get(f.path)!,
        isDirty: unsaved[f.path] !== undefined,
      }))

    const editor = (f: TrackedFile) => {
      if (!Client) return null
      const text = textOf(f)
      const props = {
        file: f.path,
        text,
        patch: makePatch(f.base, text),
        rev: f.rev,
        diskHash: fingerprint(f.disk),
        conflict: f.conflict,
        expanded: f.isExpanded,
        isFocused: f === selected,
        surface: e.surface,
        language: languageOf(f.path) ?? null,
        isDark,
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
          <Client key={`file-${f.id}`} module="./editor.tsx" props={props} width="100%" />
        </Box>
      )
    }

    const f = selected
    const draft = unsaved[f.path]
    const isDirty = draft !== undefined
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

    const tools = (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text tabular>
            <Text color="success">+{added}</Text> <Text color="error">−{removed}</Text>
          </Text>
          {squares}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button
            key={`expand-${f.id}`}
            label={f.isExpanded ? 'Changes only' : 'Whole file'}
            variant="secondary"
            onPress={() => patchFile($, f.path, x => ({ ...x, isExpanded: !x.isExpanded }))}
          />
          {f.base !== textOf(f) && !f.isNew ? (
            <Button key={`revert-${f.id}`} label="Revert to original" variant="secondary" onPress={revert(f.path)} />
          ) : null}
          <Button key={`remove-${f.id}`} label="Remove from list" variant="secondary" onPress={remove(f.path)} />
        </Box>
      </Box>
    )

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
        {f.isDeleted ? <Text color="warning">The file was deleted from disk. Save creates it again.</Text> : null}
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
        {Client ? (
          <Box flexDirection="column">
            {list.filter(x => x === selected || unsaved[x.path] !== undefined).map(editor)}
          </Box>
        ) : null}
      </Box>
    )

    const columns = e.props.bodyColumns
    const isWide = columns >= 90
    const sideWidth = Math.max(26, Math.min(44, Math.floor(columns * 0.28)))
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
            CHANGED FILES
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
      <Box flexDirection="column">
        {toolbar}
        {confirm}
        <Box flexDirection={isWide ? 'row' : 'column'} gap={1} marginTop={1}>
          {fileList}
          {detail}
        </Box>
      </Box>
    )
  })
}

function without(d: Drafts, path: string): Drafts {
  const { [path]: _, ...rest } = d

  return rest
}
