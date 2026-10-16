import { expect, mock, test } from 'claude-code/testing'
import type { Engine, FoundElement } from 'claude-code/testing'
import type { On } from 'claude-code'

const FILE = '/proj/src/a.ts'
const PANE = {
  plugin: 'editable-diff',
  component: 'Pane',
  requestId: 'editable-diff',
  props: {
    title: "Claude's edits",
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** A disk in memory with modification times, an Edit tool that edits it, and records of toasts and copies. */
function world(on: On, files: Record<string, string>, { isPlaced = true } = {}) {
  const disk = new Map(Object.entries(files))
  const mtime = new Map<string, number>()
  let clock = 1
  const touch = (path: string, text: string) => {
    disk.set(path, text)
    mtime.set(path, ++clock)
  }
  for (const [path, text] of Object.entries(files)) touch(path, text)
  const toasts: string[] = []
  const copies: string[] = []
  on('session.cwd', () => ({ value: '/proj' }))
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'no room' } }))
  on('ui.panes', () => ({ value: [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    copies.push(e.text)
    return { value: { isCopied: true } }
  })
  on('fs.read', ($, e) => {
    const text = disk.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.stat', ($, e) => {
    const text = disk.get(e.path)
    if (text === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind: 'file', size: text.length, mtimeMs: mtime.get(e.path) ?? 0, isLink: false } }
  })
  on('fs.write', ($, e) => {
    touch(e.path, e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'Edit' }, ($, e) => {
    touch(e.file_path, (disk.get(e.file_path) ?? '').replace(e.old_string, e.new_string))
    return { result: {} } as never
  })

  return { disk, toasts, copies, touch }
}

async function claudeEdits($: Engine, old_string: string, new_string: string) {
  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string, new_string })
}

type Drawing = { findAll: (q: { type?: string; in?: string }) => Promise<FoundElement[]> }

/** The editor's line rows: each a Box with the line's background. */
async function lines(ui: Drawing): Promise<{ text: string; bg: unknown }[]> {
  const boxes = await ui.findAll({ type: 'Box', in: 'file-1' })

  return boxes.filter(b => b.key?.startsWith('l')).map(b => ({ text: b.text, bg: b.props.backgroundColor }))
}

const line = async (ui: Drawing, pattern: RegExp) => (await lines(ui)).find(l => pattern.test(l.text))

for (const surface of ['terminal', 'desktop'] as const) {
  const ADDED = surface === 'terminal' ? 'diffAddedDimmed' : '#2ea04326'
  const REMOVED = surface === 'terminal' ? 'diffRemovedDimmed' : '#f8514926'

  test(`${surface}: Claude edit shows, typing recolours lines, Save writes, Clear empties the list`, async ($, on) => {
    const { disk, toasts } = world(on, { [FILE]: 'one\ntwo\nthree\n' })
    await claudeEdits($, 'two', 'TWO')

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^Changes$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^src\/a\.ts$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^\+1 −1$/ }))?.text).toBeDefined()
    expect((await line(ui, /TWO/))?.bg).toBe(ADDED)
    expect((await line(ui, /two/))?.bg).toBe(REMOVED)
    expect((await line(ui, /one/))?.bg).toBeUndefined()

    // The person edits a context line: it turns into a change.
    await ui.key({ key: 'end', in: 'file-1' })
    await ui.key({ key: 'X', in: 'file-1' })
    expect((await line(ui, /oneX/))?.bg).toBe(ADDED)
    expect(await ui.find({ type: 'Text', text: /^\+2 −2$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /unsaved/ })).toBeDefined()
    expect(disk.get(FILE)).toBe('one\nTWO\nthree\n')

    await ui.press({ key: 'save-1' })
    expect(disk.get(FILE)).toBe('oneX\nTWO\nthree\n')
    expect(toasts).toContain('Saved src/a.ts')
    expect(await ui.find({ type: 'Text', text: /unsaved/ })).toBeUndefined()

    await ui.press({ key: 'clear' })
    expect(await ui.find({ type: 'Text', text: /No changes yet/ })).toBeDefined()
    expect(disk.get(FILE)).toBe('oneX\nTWO\nthree\n')

    // After the clear, Claude's next edit brings the file back, against its text now.
    await claudeEdits($, 'three', 'THREE')
    expect(await ui.find({ type: 'Client', key: 'file-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Client', key: 'file-2' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: drag selects, Cmd+C copies, typing replaces the selection`, async ($, on) => {
    const { copies } = world(on, { [FILE]: 'one\ntwo\nthree\n' })
    await claudeEdits($, 'two', 'TWO')
    const ui = await $.ui.mount({ ...PANE, surface })

    // Rows: one, -two, +TWO, three, ''. The gutter is 7 cells: old number, space, new number, space, space, marker, space.
    await ui.pointer({ type: 'down', x: 7, y: 3, button: 'left', in: 'file-1' })
    await ui.pointer({ type: 'move', x: 10, y: 3, button: 'left', in: 'file-1' })
    await ui.pointer({ type: 'up', x: 10, y: 3, button: 'left', in: 'file-1' })
    await ui.key({ key: 'c', meta: true, in: 'file-1' })
    expect(copies).toEqual(['thr'])

    await ui.key({ key: 'T', in: 'file-1' })
    expect(await line(ui, /^ +3 +\+ Tee/)).toBeDefined()
    await ui.unmount()
  })
}

test('undoing Claude’s change by hand leaves no coloured lines; Cmd+Z brings it back', async ($, on) => {
  world(on, { [FILE]: 'a\nb\nc\n' })
  await claudeEdits($, 'b', 'bb')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.key({ key: 'down', in: 'file-1' })
  await ui.key({ key: 'end', in: 'file-1' })
  await ui.key({ key: 'backspace', in: 'file-1' })
  expect(await ui.find({ type: 'Text', text: /^\+0 −0$/ })).toBeDefined()
  await ui.key({ key: 'z', ctrl: true, in: 'file-1' })
  expect(await ui.find({ type: 'Text', text: /^\+1 −1$/ })).toBeDefined()
  await ui.unmount()
})

test('a long line wraps to the region instead of running off the edge', async ($, on) => {
  world(on, { [FILE]: 'short\n' })
  await claudeEdits($, 'short', 'a line that is much longer than the region')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.resize({ columns: 20, rows: 40, in: 'file-1' })

  // 20 columns less the 7-cell gutter: 13 cells of text a row.
  const rows = (await lines(ui)).filter(l => l.bg === '#2ea04326')
  expect(rows.length).toBe(4)
  expect(rows.map(r => r.text.slice(7)).join('')).toBe('a line that is much longer than the region')
  await ui.unmount()
})

test('a change made in another editor shows up, and undoing Claude there drops the file', async ($, on) => {
  const { touch } = world(on, { [FILE]: 'one\ntwo\n' })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await claudeEdits($, 'two', 'TWO')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await line(ui, /TWO/)).toBeDefined()

  touch(FILE, 'one\nTWO!\n')
  await clock.advance(1000)
  expect(await line(ui, /TWO!/)).toBeDefined()

  touch(FILE, 'one\ntwo\n')
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /No changes yet/ })).toBeDefined()
  await ui.unmount()
})

test('a change on disk under unsaved edits asks which to keep', async ($, on) => {
  const { touch, disk } = world(on, { [FILE]: 'x\n' })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await claudeEdits($, 'x', 'y')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.key({ key: 'Z', in: 'file-1' })

  touch(FILE, 'w\n')
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /changed on disk/ })).toBeDefined()
  expect(await line(ui, /Zy/)).toBeDefined()

  await ui.press({ key: 'take-1' })
  expect(await ui.find({ type: 'Text', text: /changed on disk/ })).toBeUndefined()
  expect(await line(ui, /^ +1 +\+ w/)).toBeDefined()
  expect(disk.get(FILE)).toBe('w\n')
  await ui.unmount()
})

test('Clear asks first when there are unsaved edits, and never touches the disk', async ($, on) => {
  const { disk } = world(on, { [FILE]: 'x\n' })
  await claudeEdits($, 'x', 'y')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.key({ key: 'Z', in: 'file-1' })

  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /will be lost/ })).toBeDefined()
  await ui.press({ key: 'clear-yes' })
  expect(await ui.find({ type: 'Text', text: /No changes yet/ })).toBeDefined()
  expect(disk.get(FILE)).toBe('y\n')
  await ui.unmount()
})

test('a large diff shows 100 rows at a time and the window moves by 50', async ($, on) => {
  world(on, { [FILE]: 'x\n' })
  const many = Array.from({ length: 300 }, (_, i) => `L${i + 1}`).join('\n')
  await claudeEdits($, 'x', many)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Rows: -x, +L1 … +L300, then the trailing empty line; the first 100 are drawn.
  expect(await line(ui, / L99$/)).toBeDefined()
  expect(await line(ui, / L100$/)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Show next 50 lines/, in: 'file-1' })).toBeDefined()

  await ui.pointer({ type: 'down', x: 10, y: 100, button: 'left', in: 'file-1' })
  expect(await ui.find({ type: 'Text', text: /Show previous 50 lines/, in: 'file-1' })).toBeDefined()
  expect(await line(ui, / L49$/)).toBeUndefined()
  expect(await line(ui, / L50$/)).toBeDefined()
  expect(await line(ui, / L149$/)).toBeDefined()
  await ui.unmount()
})

test('picking a file in the list shows its diff', async ($, on) => {
  const B = '/proj/src/b.ts'
  world(on, { [FILE]: 'one\n', [B]: 'uno\n' })
  await claudeEdits($, 'one', 'ONE')
  await $.tool.call({ tool: 'Edit', file_path: B, old_string: 'uno', new_string: 'UNO' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // The newest edit is shown first; the list is sorted by path: a.ts, b.ts.
  expect(await ui.find({ type: 'Client', key: 'file-2' })).toBeDefined()
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'files' })
  expect(await ui.find({ type: 'Client', key: 'file-1' })).toBeDefined()
  expect(await ui.find({ type: 'Client', key: 'file-2' })).toBeUndefined()
  expect(await line(ui, /ONE/)).toBeDefined()
  await ui.unmount()
})

test('code is coloured by its language', async ($, on) => {
  world(on, { [FILE]: 'let x = 1\n' })
  await claudeEdits($, 'let', 'const')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = await ui.findAll({ type: 'Text', in: 'file-1' })
  const keyword = texts.filter(t => t.text === 'const').map(t => t.props.color)
  expect(keyword.some(c => c === '#ff7b72' || c === '#cf222e')).toBe(true)
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the band above the prompt clears the list, asking first over unsaved edits`, async ($, on) => {
    // No room for the pane on this surface: the band stands in for it.
    const { disk } = world(on, { [FILE]: 'x\n' }, { isPlaced: false })
    // Beneath the mod: the band the engine draws when no plugin has one.
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box key="engine-band" />
    })
    await claudeEdits($, 'x', 'y')
    const BAND = {
      plugin: 'editable-diff',
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 100,
        scroll: { offset: 0, bodyRows: 10 },
        view: {},
      },
    } as const
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /^● Claude's edits · 1 file$/ })).toBeDefined()

    // An unsaved edit in the pane: Clear asks first.
    const pane = await $.ui.mount({ ...PANE, surface })
    await pane.key({ key: 'Z', in: 'file-1' })
    await band.press({ key: 'band-clear' })
    expect(await band.find({ type: 'Text', text: /will be lost/ })).toBeDefined()
    await band.press({ key: 'band-clear-yes' })
    expect(await band.find({ type: 'Text', text: /Claude's edits/ })).toBeUndefined()
    expect(disk.get(FILE)).toBe('y\n')

    // Claude's next edit brings the band back.
    await claudeEdits($, 'y', 'z')
    expect(await band.find({ type: 'Text', text: /^● Claude's edits · 1 file$/ })).toBeDefined()
    await pane.unmount()
    await band.unmount()
  })
}

test('the desktop cursor is drawn on the row and column clicked', async ($, on) => {
  world(on, { [FILE]: 'one\ntwo\nthree\n' })
  await claudeEdits($, 'two', 'TWO')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Row 3 is "three"; the text starts after the 7-cell gutter, so x 9 is between "th" and "ree".
  await ui.pointer({ type: 'down', x: 9, y: 3, button: 'left', in: 'file-1' })
  await ui.pointer({ type: 'up', x: 9, y: 3, button: 'left', in: 'file-1' })
  const caret = await ui.find({ type: 'Box', key: 'caret', in: 'file-1' })
  expect(caret?.props.top).toBe(3)
  expect(caret?.props.left).toBe(8)
  await ui.unmount()
})

test('long changed lines: the window stops short of the tree bounds, and Show next skips no line', async ($, on) => {
  const line = (i: number) =>
    `    const value${i} = await someFunction(argumentNumberOne, argumentNumberTwo, "string literal ${i}") // c`
  const old = Array.from({ length: 200 }, (_, i) => line(i)).join('\n')
  world(on, { [FILE]: `${old}\n` })
  await claudeEdits($, old, old.replace(/value/g, 'VALUE'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.resize({ columns: 90, rows: 40, in: 'file-1' })

  const shown = async () => (await lines(ui)).map(l => /(?:value|VALUE)(\d+) /.exec(l.text)?.[0]).filter(Boolean)
  const before = await shown()
  expect(await ui.find({ type: 'Text', text: /Show next/, in: 'file-1' })).toBeDefined()
  const last = before[before.length - 1]!

  const nextRow =
    (await ui.findAll({ type: 'Box', in: 'file-1' })).filter(b => /^[lwg]\d+$/.test(b.key ?? '')).length - 1
  expect(before.length).toBeGreaterThan(0)
  await ui.pointer({ type: 'down', x: 10, y: nextRow, button: 'left', in: 'file-1' })
  const after = await shown()
  // The window moved on to the row right after the last one drawn: none skipped.
  expect(after[0]).toBe(`value${Number(/\d+/.exec(last)![0]) + 1} `)
  await ui.unmount()
})
