// The world beneath the mod, in memory: in the test kit there is nothing
// beneath the plugins, no fs, no processes, no session.
import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

import { diffText } from '../hooks/diff'
import type { Registry } from '../types'

export const ROOT = '/repo'
export const HOME = '/home/u'
export const SESSION = 'S1'
export const DATA = `${HOME}/.claude/keep-or-undo/${SESSION}`
export const PLUGIN = 'keep-or-undo'

export type World = {
  files: Map<string, string>
  /** Paths fs.read refuses as over 4 MiB. */
  tooBig: Set<string>
  /** Every write that went through fs.write, in order. */
  writes: string[]
  rm: string[][]
  toasts: string[]
  opened: string[]
  sessionId: string
  turns: number
  agents: { id: string; type: string; description: string }[]
  /** The next editing tool call answers with these extra fields. */
  extra: Record<string, unknown>
}

function parentsOf(path: string): string[] {
  const parts = path.split('/')
  const out: string[] = []
  for (let i = 2; i < parts.length; i += 1) out.push(parts.slice(0, i).join('/'))
  return out
}

export function setup(on: On, initial: Record<string, string> = {}): World {
  const w: World = {
    files: new Map(Object.entries(initial)),
    tooBig: new Set(),
    writes: [],
    rm: [],
    toasts: [],
    opened: [],
    sessionId: SESSION,
    turns: 1,
    agents: [],
    extra: {},
  }
  const isDir = (path: string) => [...w.files.keys()].some(f => f.startsWith(`${path.replace(/\/$/, '')}/`))

  mock.env(on, { HOME })
  mock.store(on)
  mock.clock(on, { now: 1_700_000_000_000 })

  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) || isDir(e.path) }))
  on('fs.read', ($, e) => {
    if (w.tooBig.has(e.path)) return { deny: 'over 4 MiB' }
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    w.writes.push(e.path)
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    const text = w.files.get(e.path)
    if (text !== undefined) return { value: { kind: 'file' as const, size: text.length, mtimeMs: 1, isLink: false, realPath: e.path } }
    if (isDir(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path.replace(/\/$/, '') } }
    return { deny: `ENOENT: ${e.path}` }
  })
  on('fs.list', ($, e) => {
    const prefix = `${e.path.replace(/\/$/, '')}/`
    const names = new Set<string>()
    for (const f of w.files.keys()) if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0]!)
    return {
      value: [...names].map(name => ({
        name,
        kind: w.files.has(prefix + name) ? ('file' as const) : ('dir' as const),
        size: 0,
        mtimeMs: 0,
        isLink: false,
      })),
    }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    w.rm.push(argv)
    if (argv[0] === 'rm') {
      const targets = argv.slice(argv.indexOf('--') + 1)
      for (const target of targets) {
        for (const f of [...w.files.keys()]) if (f === target || f.startsWith(`${target}/`)) w.files.delete(f)
      }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  on('session.id', () => ({ value: w.sessionId }))
  on('session.root', () => ({ value: ROOT }))
  on('session.turns', () => ({ value: w.turns }))
  on('agent.list', () => ({ value: w.agents.map(a => ({ ...a, status: 'running' as const })) }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })

  // The editing tools, as the engine runs them.
  on('tool.call', ($, e) => {
    const extra = w.extra
    w.extra = {}
    if (e.tool === 'Edit') {
      const original = w.files.get(e.file_path) ?? null
      if (original === null && e.old_string !== '') return { isError: true, result: 'File does not exist.', text: 'File does not exist.' }
      const updated = original === null ? e.new_string : e.replace_all ? original.split(e.old_string).join(e.new_string) : original.replace(e.old_string, e.new_string)
      const staged = extra.staged === true
      if (!staged) w.files.set(e.file_path, updated)
      return {
        result: {
          filePath: e.file_path,
          oldString: e.old_string,
          newString: e.new_string,
          originalFile: original,
          structuredPatch: diffText(original ?? '', updated),
          userModified: false,
          replaceAll: e.replace_all === true,
          ...extra,
        },
      } as never
    }
    if (e.tool === 'Write') {
      const original = w.files.get(e.file_path) ?? null
      const staged = extra.staged === true
      if (!staged) w.files.set(e.file_path, e.content)
      return {
        result: {
          type: original === null ? 'create' : 'update',
          filePath: e.file_path,
          content: e.content,
          // Like the engine: no patch for a new file.
          structuredPatch: original === null ? [] : diffText(original, e.content),
          originalFile: original,
          ...extra,
        },
      } as never
    }
    if (e.tool === 'NotebookEdit') {
      // A bare-bones notebook: a JSON of cell sources by id.
      const original = w.files.get(e.notebook_path)
      if (original === undefined) return { isError: true, result: 'Notebook does not exist.', text: 'Notebook does not exist.' }
      const cells = JSON.parse(original) as Record<string, string>
      const id = e.cell_id ?? 'c0'
      const oldSource = cells[id]
      const mode = e.edit_mode ?? 'replace'
      if (mode === 'delete') delete cells[id]
      else cells[mode === 'insert' ? `${id}+` : id] = e.new_source
      const updated = JSON.stringify(cells, null, 1)
      w.files.set(e.notebook_path, updated)
      return {
        result: {
          new_source: e.new_source,
          ...(mode === 'insert' ? {} : { old_source: oldSource }),
          cell_id: id,
          cell_type: 'code',
          language: 'python',
          edit_mode: mode,
          notebook_path: e.notebook_path,
          original_file: original,
          updated_file: updated,
          ...extra,
        },
      } as never
    }
    return { deny: `tool ${e.tool} not simulated` }
  })
  return w
}

export function index(w: World): Registry {
  const text = w.files.get(`${DATA}/index.json`)
  if (text === undefined) return { files: {}, order: [] }
  return (JSON.parse(text) as { registry: Registry }).registry
}

export const PANE_PROPS = {
  title: "Claude's changes",
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

export const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}
