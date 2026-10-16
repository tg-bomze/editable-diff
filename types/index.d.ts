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
}

/** The counters an editor instance last posted. */
export type Counters = { saveSeq: number; copySeq: number; focusSeq: number }

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
  copySeq: number
  focusSeq: number
  /** What the last copy or cut took. */
  clip: string
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
    }
  }
}
