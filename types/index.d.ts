/** One file Claude changed since the buffer was last cleared. */
export type TrackedFile = {
  /** Stable id for the Client key; never reused within a session. */
  id: number
  /** Absolute path, as the Edit/Write tool named it. */
  path: string
  /** Path shown in the pane: relative to the session's folder when under it. */
  display: string
  /** The file's text before Claude's first edit ('' for a file Claude created). */
  base: string
  /** The file's text on disk as last read: after Claude's edit, a save, or a change made elsewhere. */
  disk: string
  /** Bumped whenever the editor must take its text afresh (the file changed, edits discarded). */
  rev: number
  /** Claude created the file. */
  isNew: boolean
  /** The file changed on disk while the person had unsaved edits in it. */
  conflict: boolean
  /** The file is gone from disk. */
  isDeleted: boolean
  /** Show the whole file, not only the changes. */
  isExpanded: boolean
  /** The file's modification time and size as last read, to notice changes made elsewhere. */
  mtimeMs: number
  size: number
  /** The file's text when Claude first changed it in the turn `turnId`. */
  turnBase?: string
  turnId?: string
  /** The file's text at git HEAD: '' when git does not track it, null outside a repository, absent until read. */
  head?: string | null
}

/** What the diff is drawn against: the text before Claude's first edit, at the start of Claude's last turn, or at git HEAD. */
export type BaseMode = 'session' | 'turn' | 'head'

/** A review comment on lines of a file, sent to Claude with the others. */
export type ReviewComment = {
  id: number
  path: string
  display: string
  /** 1-based, inclusive, in the file's text when the comment was made. */
  from: number
  to: number
  /** The lines commented on, as they were. */
  quote: string
  text: string
}

/** A button of the pane asking the editor to act; acted on once per `seq`. */
export type EditorCommand = { seq: number; kind: 'next' | 'prev' | 'first' | 'last' | 'find' }

/** The counters an editor instance last posted. */
export type Counters = {
  saveSeq: number
  copySeq: number
  focusSeq: number
  commentSeq: number
  edgeSeq: number
  revealSeq: number
}

/** Unsaved edits, by absolute path: the editor's whole text. */
export type Drafts = Record<string, string>

/** What the editor posts to the hooks module: a full snapshot, counters cumulative. */
export type EditorPost = Counters & {
  path: string
  /** Which editor instance posted: its counters start at 0. */
  instance: string
  text: string
  isDirty: boolean
  /** What the last copy or cut took. */
  clip: string
  /** The lines the cursor or selection is on, 1-based, inclusive. */
  sel: [number, number]
  /** Past which end the last F7 found no more changes: 1 after the last, -1 before the first. */
  edge: 1 | -1
  /** The last command acted on. */
  cmdSeq: number
}

/** What the file list posts: the file the person picked. */
export type FilesPost = { select: string; seq: number }

declare module 'claude-code' {
  interface PluginState {
    'editable-diff': {
      files: TrackedFile[]
      drafts: Drafts
      nextId: number
      isConfirmingClear: boolean
      seen: Record<string, Counters>
      /** The file shown in the pane (picked in the list); the first file when it names none. */
      active: string
      isPaneOpen: boolean
      baseMode: BaseMode
      /** Claude's current or last turn on the main loop that began with a prompt. */
      turnId: string
      isSplit: boolean
      ignoreWhitespace: boolean
      /** Files marked as viewed: the fingerprint of the text marked; a change unmarks it. */
      viewed: Record<string, string>
      comments: ReviewComment[]
      /** The lines a comment is being written on. */
      composing: { path: string; from: number; to: number } | null
      commands: Record<string, EditorCommand>
      /** Per editor key: what its rows may serialize to, halved each time the surface refused a drawing. */
      budgets: Record<string, number>
    }
  }
}
