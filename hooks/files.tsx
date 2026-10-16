// The changed-files list, as GitHub Desktop's sidebar draws it: one row per
// file with its status, name, folder and counts; the selected row highlighted.
// A file marked as viewed is ticked and dimmed. A click or up/down posts the file to select.
// Past ROWS files the list scrolls within itself: by the wheel while the
// pointer is over it (the hooks module hears the wheel and hands it on), by
// the scrollbar, and to keep the selected file in view.

import type { ClientModule } from 'claude-code'

import type { FilesPost, ListScroll } from '../types'

/** How many files the list shows at once. */
export const ROWS = 10

export type FileRow = {
  path: string
  name: string
  dir: string
  /** A added, M modified, D deleted from disk. */
  status: 'A' | 'M' | 'D'
  added: number
  removed: number
  isDirty: boolean
  isViewed: boolean
}

export type FilesProps = {
  rows: FileRow[]
  selected: string
  surface: string
  isDark: boolean
  /** The wheel's last move over the list, acted on once per `seq`. */
  scroll: ListScroll | null
}

type Box = {
  props: FilesProps
  seq: number
  /** The first file shown. */
  top: number
  /** The selected file and the wheel move last acted on. */
  shownSel: string
  scrollSeq: number
  isOver: boolean
  /** The scrollbar row the thumb was grabbed at, and the top then. */
  grab: { y: number; top: number } | null
}

/** Mutable, so the handlers set up on the first draw see the latest props. */
type State = { box: Box }

const STATUS_COLOR = { A: 'success', M: 'warning', D: 'error' } as const
const STATUS_GROUND = { A: '#2ea04333', M: '#d2992633', D: '#f8514933' } as const

const Files: ClientModule<FilesProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const isApp = props.surface !== 'terminal'
  let box = surface.state?.box
  if (!box) {
    const b: Box = {
      props,
      seq: 0,
      top: 0,
      shownSel: '',
      // A wheel move from before this instance is not its own.
      scrollSeq: props.scroll?.seq ?? 0,
      isOver: false,
      grab: null,
    }
    const select = (path: string | undefined) => {
      if (!path || path === b.props.selected) return
      b.seq++
      const data: FilesPost = { select: path, seq: b.seq }
      surface.post(data)
    }
    const hover = (isOver: boolean) => {
      if (isOver === b.isOver) return
      b.isOver = isOver
      const data: FilesPost = { isOver }
      surface.post(data)
    }
    const scrollTo = (top: number) => {
      const at = clamp(top, b.props.rows.length)
      if (at === b.top) return
      b.top = at
      surface.setState({ box: b })
    }
    surface.onPointer(ev => {
      if (ev.type === 'leave') hover(false)
      else if (ev.type === 'enter' || (ev.type === 'move' && !ev.button)) hover(true)
      const n = b.props.rows.length
      const bar = n > ROWS ? thumb(n, b.top) : undefined
      if (ev.type === 'up') b.grab = null
      if (ev.type === 'move' && b.grab && bar) {
        // Dragging the thumb: the list moves as far, in files, as the thumb in rows.
        scrollTo(b.grab.top + Math.round(((ev.y - b.grab.y) * (n - ROWS)) / Math.max(1, ROWS - bar.size)))
      }
      if (ev.type !== 'down' || (ev.button !== undefined && ev.button !== 'left')) return
      if (bar && surface.columns > 0 && ev.x >= surface.columns - 1) {
        if (ev.y >= bar.at && ev.y < bar.at + bar.size) b.grab = { y: ev.y, top: b.top }
        else scrollTo(b.top + (ev.y < bar.at ? -ROWS : ROWS))
        return
      }
      select(b.props.rows[b.top + ev.y]?.path)
    })
    surface.onKey(ev => {
      const { rows, selected } = b.props
      const at = rows.findIndex(r => r.path === selected)
      if (ev.key === 'up') select(rows[Math.max(0, at - 1)]?.path)
      else if (ev.key === 'down') select(rows[Math.min(rows.length - 1, at + 1)]?.path)
    })
    surface.setState({ box: b })
    box = b
  }
  box.props = props
  if (props.scroll && props.scroll.seq !== box.scrollSeq) {
    box.scrollSeq = props.scroll.seq
    box.top += props.scroll.by
  }
  // A file newly selected (a click, the keys, the panel moving on) comes into view.
  const at = props.rows.findIndex(r => r.path === props.selected)
  if (props.selected !== box.shownSel && at >= 0) {
    box.shownSel = props.selected
    if (at < box.top) box.top = at
    else if (at >= box.top + ROWS) box.top = at - ROWS + 1
  }
  box.top = clamp(box.top, props.rows.length)

  const hover = props.isDark ? '#ffffff0d' : '#0000000a'
  const n = props.rows.length
  const bar = n > ROWS ? thumb(n, box.top) : undefined

  return (
    <Box flexDirection="column" width="100%">
      {props.rows.slice(box.top, box.top + ROWS).map((row, k) => {
        const isSelected = row.path === props.selected
        const isThumb = bar !== undefined && k >= bar.at && k < bar.at + bar.size

        return (
          // One line per file, whatever its length: a click's row is the file's.
          <Box key={`f-${row.path}`} flexDirection="row" width="100%" height={1} overflow="hidden">
            <Box
              flexDirection="row"
              flexGrow={1}
              flexShrink={1}
              minWidth={0}
              overflow="hidden"
              backgroundColor={isSelected && isApp ? '#388bfd26' : undefined}
              hover={isSelected || !isApp ? undefined : { backgroundColor: hover }}
            >
              <Box flexShrink={0}>
                <Text wrap="truncate-end" inverse={isSelected && !isApp}>
                  <Text color="suggestion">{isSelected ? '▎' : ' '}</Text>
                  {row.isViewed ? <Text color="success">✓ </Text> : ''}
                  <Text weight={isSelected ? 'semibold' : undefined} dimColor={row.isViewed && !isSelected}>
                    {row.name}
                  </Text>
                </Text>
              </Box>
              {/* The folder gives way first, cut from its start so its last names show. */}
              <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" paddingLeft={1}>
                {row.dir ? (
                  <Text dimColor wrap="truncate-start" inverse={isSelected && !isApp}>
                    {row.dir}
                  </Text>
                ) : null}
              </Box>
              <Box flexShrink={0} paddingLeft={1}>
                <Text tabular wrap="truncate-end">
                  {row.isDirty ? <Text color="warning">● </Text> : ''}
                  <Text color="success">+{row.added}</Text> <Text color="error">−{row.removed}</Text>{' '}
                  <Text
                    color={STATUS_COLOR[row.status]}
                    backgroundColor={isApp ? STATUS_GROUND[row.status] : undefined}
                  >
                    {' '}
                    {row.status}{' '}
                  </Text>
                </Text>
              </Box>
            </Box>
            {bar ? (
              <Text key={`bar-${k}`} color={isThumb ? undefined : 'subtle'} dimColor={isThumb}>
                {isThumb ? '┃' : '│'}
              </Text>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

/** The first file shown, kept so the list stays full: from 0 to `n - ROWS`. */
const clamp = (top: number, n: number) => Math.max(0, Math.min(top, n - ROWS))

/** The scrollbar's thumb: its first row and its length, in rows. */
function thumb(n: number, top: number): { at: number; size: number } {
  const size = Math.max(1, Math.round((ROWS * ROWS) / n))

  return { at: Math.round((top * (ROWS - size)) / (n - ROWS)), size }
}

export default Files
