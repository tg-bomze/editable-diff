import { expect, test } from 'claude-code/testing'
import type { ElementQuery, Engine, FoundElement } from 'claude-code/testing'
import type { On } from 'claude-code'

const FILE = '/proj/src/a.ts'
const PANE = {
  plugin: 'editable-diff',
  component: 'Pane',
  requestId: 'editable-diff',
  props: {
    title: 'Правки',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** A disk in memory, an Edit tool that edits it, and a record of toasts. */
function world(on: On, files: Record<string, string>) {
  const disk = new Map(Object.entries(files))
  const toasts: string[] = []
  on('session.cwd', () => ({ value: '/proj' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = disk.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    disk.set(e.path, e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'Edit' }, ($, e) => {
    const text = disk.get(e.file_path) ?? ''
    disk.set(e.file_path, text.replace(e.old_string, e.new_string))
    return { result: {} } as never
  })

  return { disk, toasts }
}

async function claudeEdits($: Engine, old_string: string, new_string: string) {
  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string, new_string })
}

const row = async (ui: { find: (q: ElementQuery) => Promise<FoundElement | undefined> }, text: RegExp) =>
  ui.find({ type: 'Text', text, in: 'file-1' })

test('Claude edit shows in the pane, typing recolours lines, Save writes, Clear empties the list', async ($, on) => {
  const { disk, toasts } = world(on, { [FILE]: 'one\ntwo\nthree\n' })
  await claudeEdits($, 'two', 'TWO')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Изменено файлов: 1/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /src\/a\.ts/, in: 'file-1' }))?.text).toMatch(/\+1 -1/)
  expect((await row(ui, /TWO/))?.props.backgroundColor).toBe('diffAdded')
  expect((await row(ui, /two/))?.props.backgroundColor).toBe('diffRemoved')
  expect((await row(ui, /one/))?.props.backgroundColor).toBeUndefined()

  // The person edits a context line: it turns into a change.
  await ui.key({ key: 'end', in: 'file-1' })
  await ui.key({ key: 'X', in: 'file-1' })
  expect((await row(ui, /oneX/))?.props.backgroundColor).toBe('diffAdded')
  expect((await ui.find({ type: 'Text', text: /src\/a\.ts/, in: 'file-1' }))?.text).toMatch(/\+2 -2.*не сохранено/)
  expect(disk.get(FILE)).toBe('one\nTWO\nthree\n')

  await ui.press({ key: 'save' })
  expect(disk.get(FILE)).toBe('oneX\nTWO\nthree\n')
  expect(toasts).toContain('Сохранено: src/a.ts')
  expect((await ui.find({ type: 'Text', text: /src\/a\.ts/, in: 'file-1' }))?.text).not.toMatch(/не сохранено/)

  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /Нет изменённых файлов/ })).toBeDefined()
  expect(disk.get(FILE)).toBe('oneX\nTWO\nthree\n')

  // After the clear, Claude's next edit brings the file back, against its text now.
  await claudeEdits($, 'three', 'THREE')
  expect(await ui.find({ type: 'Client', key: 'file-1' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /src\/a\.ts/, in: 'file-2' }))?.text).toMatch(/\+1 -1/)
  await ui.unmount()
})

test('undoing Claude’s change by hand leaves no coloured lines', async ($, on) => {
  world(on, { [FILE]: 'a\nb\nc\n' })
  await claudeEdits($, 'b', 'bb')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.key({ key: 'down', in: 'file-1' })
  await ui.key({ key: 'end', in: 'file-1' })
  await ui.key({ key: 'backspace', in: 'file-1' })
  expect((await ui.find({ type: 'Text', text: /src\/a\.ts/, in: 'file-1' }))?.text).toMatch(/\+0 -0/)
  await ui.key({ key: 'z', ctrl: true, in: 'file-1' })
  expect((await ui.find({ type: 'Text', text: /src\/a\.ts/, in: 'file-1' }))?.text).toMatch(/\+1 -1/)
  await ui.unmount()
})

test('Clear asks first when there are unsaved edits, and never touches the disk', async ($, on) => {
  const { disk } = world(on, { [FILE]: 'x\n' })
  await claudeEdits($, 'x', 'y')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.key({ key: 'Z', in: 'file-1' })

  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /пропадут/ })).toBeDefined()
  await ui.press({ key: 'clear-yes' })
  expect(await ui.find({ type: 'Text', text: /Нет изменённых файлов/ })).toBeDefined()
  expect(disk.get(FILE)).toBe('y\n')
  await ui.unmount()
})
