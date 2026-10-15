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
  /** The file's text on disk as of Claude's last edit or the person's last save. */
  disk: string
  /** Bumped whenever the editor must take `disk` afresh (Claude edited, edits discarded). */
  rev: number
  /** Claude created the file. */
  isNew: boolean
  /** Claude changed the file on disk while the person had unsaved edits in it. */
  conflict: boolean
}

/** The counters an editor instance last posted. */
export type Counters = { saveSeq: number; discardSeq: number; keepSeq: number }

/** Unsaved edits, by absolute path: the editor's whole text. */
export type Drafts = Record<string, string>

/** What the editor posts to the hooks module: a full snapshot, counters cumulative. */
export type EditorPost = {
  path: string
  /** Which editor instance posted: its counters start at 0. */
  instance: string
  text: string
  isDirty: boolean
  saveSeq: number
  discardSeq: number
  keepSeq: number
}

declare module 'claude-code' {
  interface PluginState {
    'editable-diff': {
      files: TrackedFile[]
      drafts: Drafts
      nextId: number
      isConfirmingClear: boolean
      seen: Record<string, Counters>
    }
  }
}
