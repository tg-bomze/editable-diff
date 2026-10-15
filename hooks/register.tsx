import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Drafts, EditorPost, TrackedFile } from '../types'
import { fingerprint, makePatch } from './diff'

const PANE = 'editable-diff'
const TITLE = 'Правки'
/** A Client's props go whole or not at all; past this the file is shown, not edited. */
const MAX_PROPS = 95_000

const files = atom({ plugin: 'editable-diff', key: 'files' } as const, [])
const drafts = atom({ plugin: 'editable-diff', key: 'drafts' } as const, {})
const nextId = atom({ plugin: 'editable-diff', key: 'nextId' } as const, 1)
const isConfirmingClear = atom({ plugin: 'editable-diff', key: 'isConfirmingClear' } as const, false)
/** The last counters each editor instance posted, so a counter that moved acts once, reloads included. */
const seen = atom({ plugin: 'editable-diff', key: 'seen' } as const, {})

function isPost(data: unknown): data is EditorPost {
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>

  return (
    typeof d.path === 'string' &&
    typeof d.instance === 'string' &&
    typeof d.text === 'string' &&
    typeof d.isDirty === 'boolean' &&
    typeof d.saveSeq === 'number' &&
    typeof d.discardSeq === 'number' &&
    typeof d.keepSeq === 'number'
  )
}

function relative(path: string, cwd: string): string {
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`

  return cwd && path.startsWith(root) ? path.slice(root.length) : path
}

/** The session's folder, read at session start: paths under it are shown relative. */
let cwd = ''

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)

    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

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
      ? { ...old, disk: after, rev: old.rev + 1, conflict: old.conflict || (hasDraft && after !== old.disk) }
      : {
          id,
          path,
          display: relative(path, cwd),
          base: before ?? '',
          disk: after,
          rev: 1,
          isNew: before === undefined,
          conflict: false,
        }

    return [file, ...rest]
  })
  if (wasEmpty) void $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = await $.session.cwd()
    await $.command.register({
      name: 'editable-diff',
      description: 'Открыть панель с правками Claude: diff, правка на месте, сохранение',
    })

    return next(e)
  })

  on('command.run', { command: 'editable-diff' }, async $ => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })

    return { text: isPlaced ? 'Панель правок открыта.' : 'Панель правок откроется, когда для неё хватит места.' }
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

  // What an editor posted: its whole text and the counters of its buttons.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || !isPost(e.data)) return next(e)
    const post = e.data
    const file = (await read($, files)).find(f => f.path === post.path)
    if (!file) return next(e)
    const last = (await read($, seen))[post.instance] ?? { saveSeq: 0, discardSeq: 0, keepSeq: 0 }
    await update($, seen, s => ({
      ...s,
      [post.instance]: { saveSeq: post.saveSeq, discardSeq: post.discardSeq, keepSeq: post.keepSeq },
    }))

    if (post.discardSeq > last.discardSeq) {
      await update($, drafts, d => without(d, post.path))
      await update($, files, list =>
        list.map(f => (f.path === post.path ? { ...f, rev: f.rev + 1, conflict: false } : f)),
      )

      return next(e)
    }

    await update($, drafts, d => (post.isDirty ? { ...d, [post.path]: post.text } : without(d, post.path)))

    if (post.keepSeq > last.keepSeq) {
      await update($, files, list => list.map(f => (f.path === post.path ? { ...f, conflict: false } : f)))
    }

    if (post.saveSeq > last.saveSeq) {
      if (!post.isDirty) {
        $.ui.toast(`${file.display}: нечего сохранять`)
        return next(e)
      }
      try {
        await $.fs.write(post.path, post.text)
      } catch (error) {
        $.ui.toast(`Не удалось сохранить ${file.display}: ${error instanceof Error ? error.message : String(error)}`)
        return next(e)
      }
      await update($, drafts, d => without(d, post.path))
      await update($, files, list =>
        list.map(f => (f.path === post.path ? { ...f, disk: post.text, conflict: false } : f)),
      )
      $.ui.toast(`Сохранено: ${file.display}`)
      try {
        await $.session.append({
          message: {
            type: 'user',
            content: [
              {
                type: 'text',
                text: `[editable-diff] Пользователь вручную отредактировал и сохранил ${post.path}. Перед следующей правкой этого файла перечитай его.`,
              },
            ],
          },
        })
      } catch {
        // The note is a courtesy to the model; the save already stands.
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, files)
    const unsaved = await read($, drafts)
    const confirming = await read($, isConfirmingClear)
    const dirtyCount = list.filter(f => unsaved[f.path] !== undefined).length

    const clear = async () => {
      await update($, files, () => [])
      await update($, drafts, () => ({}))
      await update($, isConfirmingClear, () => false)
      await update($, seen, () => ({}))
    }

    const { Box, Text, Button } = $.ui.resolve(e)

    const toolbar = (
      <Box flexDirection="row">
        <Text>
          {list.length === 0 ? 'Нет изменённых файлов' : `Изменено файлов: ${list.length}`}
          {dirtyCount > 0 ? <Text color="warning"> · не сохранено: {dirtyCount}</Text> : ''}
          {'  '}
        </Text>
        {list.length > 0 ? (
          <Button
            key="clear"
            label="Очистить буфер"
            onPress={async () => {
              if (Object.keys(await read($, drafts)).length > 0) {
                await update($, isConfirmingClear, () => true)
              } else {
                await clear()
              }
            }}
          />
        ) : null}
      </Box>
    )

    const confirm = confirming ? (
      <Box flexDirection="row">
        <Text color="warning">
          Несохранённые правки в {dirtyCount} файл(ах) пропадут. Файлы на диске не изменятся.{'  '}
        </Text>
        <Button key="clear-yes" label="Очистить" onPress={clear} />
        <Button key="clear-no" label="Отмена" onPress={() => update($, isConfirmingClear, () => false)} />
      </Box>
    ) : null

    const empty =
      list.length === 0 ? (
        <Text dimColor>Здесь появятся файлы, которые Claude изменит через Edit или Write.</Text>
      ) : null

    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      return (
        <Box flexDirection="column">
          {toolbar}
          {empty}
          {list.map(f => (
            <Text key={`f${f.id}`}>{f.display}</Text>
          ))}
        </Box>
      )
    }

    const { Client } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {toolbar}
        {confirm}
        {empty}
        {list.map(f => {
          const text = unsaved[f.path] ?? f.disk
          const props = {
            file: f.path,
            display: f.display,
            text,
            patch: makePatch(f.base, text),
            rev: f.rev,
            diskHash: fingerprint(f.disk),
            conflict: f.conflict,
            isNew: f.isNew,
          }
          if (JSON.stringify(props).length > MAX_PROPS) {
            return (
              <Box key={`f${f.id}`} flexDirection="column" marginTop={1}>
                <Text bold>{f.display}</Text>
                <Text dimColor>Файл слишком большой для правки в панели: откройте его в редакторе.</Text>
              </Box>
            )
          }

          return (
            <Box key={`f${f.id}`} flexDirection="column" marginTop={1}>
              <Client key={`file-${f.id}`} module="./editor.tsx" props={props} width="100%" />
            </Box>
          )
        })}
      </Box>
    )
  })
}

function without(d: Drafts, path: string): Drafts {
  const { [path]: _, ...rest } = d

  return rest
}
