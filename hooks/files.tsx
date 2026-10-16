// The changed-files list, as GitHub Desktop's sidebar draws it: one row per
// file with its status, name, folder and counts; the selected row highlighted.
// A click or up/down posts the file to select.

import type { ClientModule } from 'claude-code'

import type { FilesPost } from '../types'

export type FileRow = {
  path: string
  name: string
  dir: string
  /** A added, M modified, D deleted from disk. */
  status: 'A' | 'M' | 'D'
  added: number
  removed: number
  isDirty: boolean
}

export type FilesProps = {
  rows: FileRow[]
  selected: string
  surface: string
}

/** Mutable, so the handlers set up on the first draw see the latest props. */
type State = { box: { props: FilesProps; seq: number } }

const STATUS_COLOR = { A: 'success', M: 'warning', D: 'error' } as const

const Files: ClientModule<FilesProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const isApp = props.surface !== 'terminal'
  let box = surface.state?.box
  if (!box) {
    const b = { props, seq: 0 }
    const select = (path: string | undefined) => {
      if (!path || path === b.props.selected) return
      b.seq++
      const data: FilesPost = { select: path, seq: b.seq }
      surface.post(data)
    }
    surface.onPointer(ev => {
      if (ev.type !== 'down' || (ev.button !== undefined && ev.button !== 'left')) return
      select(b.props.rows[ev.y]?.path)
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

  return (
    <Box flexDirection="column" width="100%">
      {props.rows.map(row => {
        const isSelected = row.path === props.selected

        return (
          <Box
            key={`f-${row.path}`}
            flexDirection="row"
            width="100%"
            justifyContent="space-between"
            backgroundColor={isSelected && isApp ? '#388bfd33' : undefined}
            hover={isSelected || !isApp ? undefined : { backgroundColor: '#8b949e1a' }}
          >
            <Text wrap="truncate-end" inverse={isSelected && !isApp}>
              <Text color={STATUS_COLOR[row.status]}> {row.status} </Text>
              <Text weight={isSelected ? 'semibold' : undefined}>{row.name}</Text>
              {row.dir ? <Text dimColor> {row.dir}</Text> : ''}
            </Text>
            <Text tabular wrap="truncate-start">
              {row.isDirty ? <Text color="warning">● </Text> : ''}
              <Text color="success">+{row.added}</Text> <Text color="error">−{row.removed}</Text>{' '}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

export default Files
