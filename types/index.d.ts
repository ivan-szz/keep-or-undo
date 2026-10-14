export type ChangeTool = 'Edit' | 'Write' | 'NotebookEdit'

/** A recorded change: one successful call to Edit, Write or NotebookEdit. */
export type ChangeEntry = {
  /** The call's tool_use_id: also the prefix of its blobs. */
  id: string
  /** The main turn it happened in (`turn.start`), if known. */
  turnId: string | null
  /** The turn number (`$.session.turns()`), for messages to the model. */
  turnNumber: number | null
  tool: ChangeTool
  /** The subagent that made the change, if any. */
  agent?: string
  createdFile: boolean
  /** Blob with the content BEFORE the change; null if the file did not exist or cannot be read. */
  preRef: string | null
  /** Blob with the content AFTER the change; null if the file cannot be read (over 4 MiB). */
  postRef: string | null
  /** Blob with the unified diff to show; null if there is none. Kept out of the index to stay under the store's 4 MiB. */
  patchRef: string | null
  added: number
  removed: number
  at: number
}

export type FileEntry = {
  realPath: string
  /** Relative to session.root when under it, otherwise the real path. */
  displayPath: string
  /** Blob with the content before the FIRST pending change: where Undo goes back to. Null if the file was created. */
  baseRef: string | null
  /** The file did not exist before the first pending change. */
  createdByClaude: boolean
  entries: ChangeEntry[]
  /** The file contains absorbed external changes (requirement 6). */
  absorbedExternal: boolean
  /** Some content could not be read (over 4 MiB): undo is not available. */
  tooLarge: boolean
}

export type Registry = {
  files: Record<string, FileEntry>
  /** The realPaths in order of first change. */
  order: string[]
}

export type TurnMark = {
  id: string
  number: number
  /** Changes recorded in this turn. */
  added: number
}

/** An undo request waiting for confirmation because of later external changes. */
export type PendingConfirm = {
  paths: string[]
  /** Pressed from "Undo all": one message to the model. */
  isAll: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'keep-or-undo': {
      registry: Registry
      turn: TurnMark | null
      confirm: PendingConfirm | null
      expanded: string | null
      /** The session the registry belongs to: reloaded after a session change. */
      owner: string | null
    }
  }
}
