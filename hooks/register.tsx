import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { ChangeEntry, ChangeTool, FileEntry, PendingConfirm, Registry, TurnMark } from '../types'
import { countPatch, diffText, formatPatch, turnRange } from './diff'
import type { Hunk } from './diff'

type Engine = EngineInterface

const REGISTRY = { plugin: 'keep-or-undo', key: 'registry' } as const
const TURN = { plugin: 'keep-or-undo', key: 'turn' } as const
const CONFIRM = { plugin: 'keep-or-undo', key: 'confirm' } as const
const EXPANDED = { plugin: 'keep-or-undo', key: 'expanded' } as const
const OWNER = { plugin: 'keep-or-undo', key: 'owner' } as const

const EMPTY: Registry = { files: {}, order: [] }
const registry = atom(REGISTRY, EMPTY)
const turnMark = atom(TURN, null)
const pendingConfirm = atom(CONFIRM, null)
const expanded = atom(EXPANDED, null)
const owner = atom(OWNER, null)

const PANE = 'keep-or-undo'
const PANE_TITLE = "Claude's changes"
const DAY_MS = 24 * 60 * 60 * 1000

// Every registry operation goes through this queue, so parallel recordings,
// Keep and Undo never overlap. A module variable: after a reload it starts
// empty, which is fine.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

// Only a cache for `autoOpenPane`: turn.complete has no viewport, the band
// does.
let isFullscreen = false

function debug($: Engine, text: string): void {
  try {
    $.ui.log(`keep-or-undo: ${text}`, { to: 'debug' })
  } catch {
    // logging must never break anything
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Paths and files

async function baseDir($: Engine): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  const root = config !== undefined && config !== '' ? config : `${home ?? ''}/.claude`
  return `${root.replace(/\/+$/, '')}/keep-or-undo`
}

function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9_.-]/g, '_')
}

async function sessionDir($: Engine, sessionId?: string): Promise<string> {
  return `${await baseDir($)}/${safeName(sessionId ?? (await $.session.id()))}`
}

function blobPath(dir: string, ref: string): string {
  return `${dir}/blobs/${ref}`
}

/** The file's content: null if it does not exist, undefined if it cannot be read (over 4 MiB). */
async function readText($: Engine, path: string): Promise<string | null | undefined> {
  try {
    if (!(await $.fs.exists(path))) return null
  } catch {
    return undefined
  }
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

async function readBlob($: Engine, dir: string, ref: string): Promise<string | undefined> {
  try {
    return await $.fs.read(blobPath(dir, ref))
  } catch {
    return undefined
  }
}

async function realPathOf($: Engine, path: string): Promise<string | undefined> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath
  } catch {
    return undefined
  }
}

async function rootOf($: Engine): Promise<string> {
  const root = await $.session.root()
  return ((await realPathOf($, root)) ?? root).replace(/\/+$/, '')
}

function isInside(path: string, dir: string): boolean {
  return path.startsWith(`${dir}/`) && !path.split('/').includes('..')
}

function displayPathOf(realPath: string, root: string): string {
  return isInside(realPath, root) ? realPath.slice(root.length + 1) : realPath
}

/** Deletes files, only those under `under`. */
async function removeFiles($: Engine, paths: readonly string[], under: string): Promise<void> {
  const safe = paths.filter(p => isInside(p, under))
  if (safe.length === 0) return
  await $.process.run(['rm', '-f', '--', ...safe])
}

/** Deletes a data folder, only if it is under the mod's folder. */
async function removeDir($: Engine, dir: string): Promise<void> {
  if (!isInside(dir, await baseDir($))) return
  await $.process.run(['rm', '-rf', '--', dir])
}

function refsOf(file: FileEntry): string[] {
  const refs = new Set<string>()
  if (file.baseRef !== null) refs.add(file.baseRef)
  for (const entry of file.entries) {
    for (const ref of [entry.preRef, entry.postRef, entry.patchRef]) if (ref !== null) refs.add(ref)
  }
  return [...refs]
}

async function dropBlobs($: Engine, files: readonly FileEntry[], dir?: string): Promise<void> {
  if (files.length === 0) return
  dir ??= await sessionDir($)
  await removeFiles($, files.flatMap(refsOf).map(ref => blobPath(dir, ref)), dir)
}

// ---------------------------------------------------------------------------
// Index: in $.state, copied to $.store and to index.json

type Snapshot = { registry: Registry; updatedAt: number }

function isRegistry(value: unknown): value is Registry {
  const v = value as Registry | undefined
  return typeof v === 'object' && v !== null && typeof v.files === 'object' && Array.isArray(v.order)
}

async function persist($: Engine, reg: Registry): Promise<void> {
  const sid = await $.session.id()
  const snapshot: Snapshot = { registry: reg, updatedAt: await $.clock.now() }
  try {
    await $.store.set(`sessions/${sid}`, snapshot)
  } catch (err) {
    debug($, `store not updated: ${errorText(err)}`)
  }
  try {
    await $.fs.write(`${await sessionDir($, sid)}/index.json`, JSON.stringify(snapshot))
  } catch (err) {
    debug($, `index.json not updated: ${errorText(err)}`)
  }
}

async function loadSnapshot($: Engine, sid: string): Promise<Registry | undefined> {
  const stored = (await $.store.get(`sessions/${sid}`)) as Snapshot | undefined
  if (isRegistry(stored?.registry)) return stored.registry
  try {
    const saved = JSON.parse(await $.fs.read(`${await sessionDir($, sid)}/index.json`)) as Snapshot
    if (isRegistry(saved.registry)) return saved.registry
  } catch {
    // no copy on disk
  }
  return undefined
}

/**
 * The registry in $.state belongs to the current session. After a --resume in
 * a new process the state is empty; after a /resume or a /clear it belongs to
 * another session: either way it is reloaded from the store or index.json.
 * After a mod reload it matches and this does nothing. Call it inside serial.
 */
async function ensureOwner($: Engine): Promise<void> {
  const sid = await $.session.id()
  const held = await $.state.get(OWNER)
  if (held.value === sid) return
  const loaded = await loadSnapshot($, sid)
  await $.state.set(REGISTRY, loaded ?? EMPTY)
  await $.state.set(CONFIRM, null)
  await $.state.set(EXPANDED, null)
  await $.state.set(OWNER, sid)
}

/** Does the state belong to the current session? For renders, which never write. */
async function isOwned($: Engine): Promise<boolean> {
  return (await read($, owner)) === (await $.session.id())
}

async function cleanup($: Engine, retentionDays: number): Promise<void> {
  const cutoff = (await $.clock.now()) - retentionDays * DAY_MS
  const current = await $.session.id()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('sessions/')) continue
    const sid = key.slice('sessions/'.length)
    if (sid === current) continue
    const snapshot = (await $.store.get(key)) as Snapshot | undefined
    if (typeof snapshot?.updatedAt === 'number' && snapshot.updatedAt >= cutoff) continue
    await $.store.delete(key)
    await removeDir($, await sessionDir($, sid))
  }
  const base = await baseDir($)
  if (!(await $.fs.exists(base))) return
  for (const entry of await $.fs.list(base)) {
    if (entry.kind !== 'dir' || entry.name === safeName(current)) continue
    const dir = `${base}/${entry.name}`
    const index = `${dir}/index.json`
    const stat = await $.fs.stat((await $.fs.exists(index)) ? index : dir).catch(() => undefined)
    if (stat !== undefined && stat.mtimeMs < cutoff) await removeDir($, dir)
  }
}

function without(reg: Registry, paths: readonly string[]): Registry {
  const files = { ...reg.files }
  for (const path of paths) delete files[path]
  return { files, order: reg.order.filter(p => !paths.includes(p)) }
}

// ---------------------------------------------------------------------------
// Recording

type Observed = {
  tool: ChangeTool
  path: string
  toolUseId: string
  agentId: string | undefined
}

async function agentLabel($: Engine, agentId: string | undefined): Promise<string | undefined> {
  if (agentId === undefined) return undefined
  try {
    const agent = (await $.agent.list()).find(a => a.id === agentId)
    if (agent !== undefined) return agent.type || agent.name || agent.description
  } catch {
    // fallback below
  }
  return agentId.slice(0, 8)
}

async function record($: Engine, call: Observed, pre: string | null | undefined, r: ToolCallResult): Promise<void> {
  if (r.deny !== undefined || r.isError === true) return
  const result = r.result as Record<string, unknown> | undefined
  if (result === undefined || result === null || result.staged === true) return
  // NotebookEdit can report a failure in `error` without isError.
  if (typeof result.error === 'string' && result.error !== '') return
  await ensureOwner($)

  let before: string | null | undefined
  let created: boolean
  let patch: Hunk[] = []
  if (call.tool === 'NotebookEdit') {
    // The notebook as it was on disk: original_file is what the tool read.
    before = pre !== undefined ? pre : typeof result.original_file === 'string' ? result.original_file : undefined
    created = pre === null
    const oldSource = typeof result.old_source === 'string' ? result.old_source : ''
    const newSource = result.edit_mode === 'delete' ? '' : typeof result.new_source === 'string' ? result.new_source : ''
    patch = diffText(oldSource, newSource)
  } else {
    before = typeof result.originalFile === 'string' ? result.originalFile : pre
    created = call.tool === 'Write' ? result.type === 'create' : pre === null
    if (Array.isArray(result.structuredPatch)) patch = result.structuredPatch as Hunk[]
  }
  if (created) before = null

  // Re-read the content after the change: replaceAll and userModified can alter it.
  const after = await readText($, call.path)
  // Nothing changed on disk: nothing to record.
  if (typeof before === 'string' && before === after) return
  if (patch.length === 0 && typeof after === 'string' && before !== undefined) {
    patch = diffText(before ?? '', after)
  }
  const counted = countPatch(patch)

  const realPath = (await realPathOf($, call.path)) ?? call.path
  const root = await rootOf($)
  const dir = await sessionDir($)
  const id = safeName(call.toolUseId)

  const preRef = typeof before === 'string' ? `${id}.pre.txt` : null
  const postRef = typeof after === 'string' ? `${id}.post.txt` : null
  const patchRef = patch.length > 0 ? `${id}.patch.txt` : null
  if (preRef !== null) await $.fs.write(blobPath(dir, preRef), before as string)
  if (postRef !== null) await $.fs.write(blobPath(dir, postRef), after as string)
  if (patchRef !== null) await $.fs.write(blobPath(dir, patchRef), formatPatch(patch))

  // Requirement 6: if the content before this change is not what the last
  // recorded change left, someone touched the file in between.
  const existing = (await read($, registry)).files[realPath]
  let isExternal = false
  const last = existing?.entries[existing.entries.length - 1]
  if (last !== undefined && before !== undefined) {
    const lastPost = last.postRef === null ? undefined : await readBlob($, dir, last.postRef)
    if (lastPost !== undefined) isExternal = lastPost !== before
  }

  const turn = await read($, turnMark)
  const entry: ChangeEntry = {
    id: call.toolUseId,
    turnId: turn?.id ?? null,
    turnNumber: turn?.number ?? null,
    tool: call.tool,
    createdFile: created,
    preRef,
    postRef,
    patchRef,
    added: counted.added,
    removed: counted.removed,
    at: await $.clock.now(),
  }
  const agent = await agentLabel($, call.agentId)
  if (agent !== undefined) entry.agent = agent

  const next = await update($, registry, reg => {
    const current = reg.files[realPath]
    if (current === undefined) {
      const file: FileEntry = {
        realPath,
        displayPath: displayPathOf(realPath, root),
        baseRef: preRef,
        createdByClaude: created,
        entries: [entry],
        absorbedExternal: false,
        tooLarge: before === undefined || after === undefined,
      }
      return { files: { ...reg.files, [realPath]: file }, order: [...reg.order.filter(p => p !== realPath), realPath] }
    }
    // baseRef stays: Undo goes back to before the FIRST pending change.
    const file: FileEntry = {
      ...current,
      entries: [...current.entries, entry],
      absorbedExternal: current.absorbedExternal || isExternal,
      tooLarge: current.tooLarge || after === undefined,
    }
    return { ...reg, files: { ...reg.files, [realPath]: file } }
  })
  await update($, turnMark, t => (t === null ? t : { ...t, added: t.added + 1 }))
  await persist($, next)
}

/** Observes an editing tool: never blocks it and always returns its result. */
async function observe($: Engine, call: Observed, run: () => Promise<ToolCallResult>): Promise<ToolCallResult> {
  let pre: string | null | undefined
  try {
    pre = await readText($, call.path)
  } catch {
    pre = undefined
  }
  const r = await run()
  try {
    await serial(() => record($, call, pre, r))
  } catch (err) {
    debug($, `recording failed for ${call.path}: ${errorText(err)}`)
  }
  return r
}

// ---------------------------------------------------------------------------
// Keep, Undo, consistency

async function accept($: Engine, paths: readonly string[]): Promise<void> {
  await serial(async () => {
    await ensureOwner($)
    const reg = await read($, registry)
    const files = paths.map(p => reg.files[p]).filter((f): f is FileEntry => f !== undefined)
    const next = await update($, registry, r => without(r, paths))
    await update($, pendingConfirm, c => (c !== null && c.paths.some(p => paths.includes(p)) ? null : c))
    await dropBlobs($, files)
    await persist($, next)
  })
}

type Restored = { file: FileEntry; isDeleted: boolean }

function modelMessage(restored: readonly Restored[], isAll: boolean): string {
  const turnsOf = (file: FileEntry) => {
    const range = turnRange(file.entries.map(e => e.turnNumber))
    return range === '' ? '' : range.includes('–') || range.includes(',') ? `in turns ${range}` : `in turn ${range}`
  }
  const only = restored[0]
  if (restored.length === 1 && only !== undefined && !isAll) {
    const turns = turnsOf(only.file)
    if (only.isDeleted) {
      return `The user rejected the creation of \`${only.file.displayPath}\`${turns ? ` (changes ${turns})` : ''}: the file has been deleted. Do not recreate it unless asked.`
    }
    return `The user rejected your changes to \`${only.file.displayPath}\`: the file is back to how it was before your changes${turns ? ` ${turns}` : ''}. Re-read it before editing it again.`
  }
  const lines = restored.map(({ file, isDeleted }) => {
    const turns = turnsOf(file)
    const note = isDeleted ? 'created by you, now deleted' : 'restored'
    return `- \`${file.displayPath}\` (${note}${turns ? `; changes ${turns}` : ''})`
  })
  return [
    `The user rejected your changes to ${restored.length} files, which are back to how they were before your changes:`,
    ...lines,
    'Re-read them before editing them again.',
  ].join('\n')
}

type RejectOptions = { isAll: boolean; isConfirmed: boolean }

async function reject($: Engine, paths: readonly string[], options: RejectOptions): Promise<void> {
  await serial(async () => {
    await ensureOwner($)
    const reg = await read($, registry)
    const dir = await sessionDir($)
    const root = await rootOf($)
    const files = paths.map(p => reg.files[p]).filter((f): f is FileEntry => f !== undefined)

    type Plan = { file: FileEntry; current: string | null; base: string | null; isLaterExternal: boolean }
    const plans: Plan[] = []
    const settled: FileEntry[] = [] // already at baseRef: just drop them
    const skipped: string[] = []
    for (const file of files) {
      if (file.tooLarge) {
        skipped.push(`${file.displayPath}: too large, undo not available`)
        continue
      }
      const current = await readText($, file.realPath)
      const base = file.baseRef === null ? null : await readBlob($, dir, file.baseRef)
      if (current === undefined || base === undefined) {
        skipped.push(`${file.displayPath}: content not readable`)
        continue
      }
      if (current === base) {
        settled.push(file)
        continue
      }
      const last = file.entries[file.entries.length - 1]
      const lastPost = last?.postRef == null ? undefined : await readBlob($, dir, last.postRef)
      plans.push({ file, current, base, isLaterExternal: lastPost === undefined || lastPost !== current })
    }

    if (!options.isConfirmed && plans.some(p => p.isLaterExternal)) {
      const confirm: PendingConfirm = { paths: [...paths], isAll: options.isAll }
      await $.state.set(CONFIRM, confirm)
      return
    }

    const restored: Restored[] = []
    const backups: string[] = []
    const stamp = await $.clock.now()
    for (const plan of plans) {
      const { file, current, base } = plan
      try {
        if (plan.isLaterExternal && current !== null) {
          // The index keeps names apart when two paths share a safeName (src/a.ts, src_a.ts).
          const name = `backup-${stamp}-${backups.length}-${safeName(file.displayPath)}.txt`
          await $.fs.write(blobPath(dir, name), current)
          backups.push(blobPath(dir, name))
        }
        if (file.createdByClaude) {
          if (current !== null) {
            const real = await realPathOf($, file.realPath)
            if (real !== file.realPath || !isInside(real, root)) {
              skipped.push(`${file.displayPath}: outside the session folder, not deleting it`)
              continue
            }
            await $.process.run(['rm', '--', real])
          }
          restored.push({ file, isDeleted: true })
        } else {
          await $.fs.write(file.realPath, base ?? '')
          restored.push({ file, isDeleted: false })
        }
      } catch (err) {
        skipped.push(`${file.displayPath}: ${errorText(err)}`)
      }
    }

    const done = [...settled, ...restored.map(r => r.file)]
    const donePaths = done.map(f => f.realPath)
    const next = await update($, registry, r => without(r, donePaths))
    await $.state.set(CONFIRM, null)
    await dropBlobs($, done)
    await persist($, next)

    if (restored.length > 0) {
      try {
        await $.session.append({
          message: { type: 'user', content: [{ type: 'text', text: modelMessage(restored, options.isAll) }] },
        })
      } catch (err) {
        debug($, `could not notify the model: ${errorText(err)}`)
      }
    }
    const notes: string[] = []
    if (done.length > 0) notes.push(done.length === 1 ? `Changes to ${done[0]!.displayPath} undone` : `Changes to ${done.length} files undone`)
    if (backups.length > 0) notes.push(`backup of the overwritten content: ${backups.join(', ')}`)
    if (skipped.length > 0) notes.push(`undo not applied to ${skipped.join('; ')}`)
    if (notes.length > 0) $.ui.toast(notes.join(' · '), { timeoutMs: backups.length > 0 || skipped.length > 0 ? 12000 : 4000 })
  })
}

/** Drops files that are back at baseRef, for example after a native /rewind. */
async function reconcile($: Engine): Promise<void> {
  await serial(async () => {
    await ensureOwner($)
    const reg = await read($, registry)
    if (reg.order.length === 0) return
    const dir = await sessionDir($)
    const settled: FileEntry[] = []
    for (const path of reg.order) {
      const file = reg.files[path]
      if (file === undefined || file.tooLarge) continue
      const base = file.baseRef === null ? null : await readBlob($, dir, file.baseRef)
      if (base === undefined) continue
      const current = await readText($, file.realPath)
      if (current === base) settled.push(file)
    }
    if (settled.length === 0) return
    const next = await update($, registry, r => without(r, settled.map(f => f.realPath)))
    await dropBlobs($, settled)
    await persist($, next)
  })
}

async function openPane($: Engine): Promise<void> {
  try {
    await reconcile($)
  } catch (err) {
    debug($, `consistency check failed: ${errorText(err)}`)
  }
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

// ---------------------------------------------------------------------------
// Summary

function totals(reg: Registry): { files: number; added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const path of reg.order) {
    for (const entry of reg.files[path]?.entries ?? []) {
      added += entry.added
      removed += entry.removed
    }
  }
  return { files: reg.order.length, added, removed }
}

function filesText(count: number): string {
  return count === 1 ? '1 file' : `${count} files`
}

function badgesOf(file: FileEntry): string[] {
  const badges: string[] = []
  const agents = [...new Set(file.entries.map(e => e.agent).filter((a): a is string => a !== undefined))]
  for (const agent of agents) badges.push(`subagent: ${agent}`)
  if (file.createdByClaude) badges.push('new')
  if (file.absorbedExternal) badges.push('includes external changes')
  if (file.tooLarge) badges.push('too large, undo not available')
  return badges
}

function confirmText(confirm: PendingConfirm, reg: Registry): string {
  const only = confirm.paths.length === 1 ? reg.files[confirm.paths[0]!] : undefined
  return only !== undefined
    ? `${only.displayPath}: the file has later changes not made by Claude, which will be lost.`
    : 'Some files have later changes not made by Claude, which will be lost.'
}

async function confirmReject($: Engine): Promise<void> {
  const confirm = await read($, pendingConfirm)
  if (confirm === null) return
  await reject($, confirm.paths, { isAll: confirm.isAll, isConfirmed: true })
}

export const register: Register = (on, options) => {
  const retentionDays = typeof options.retentionDays === 'number' && options.retentionDays > 0 ? options.retentionDays : 14
  const autoOpenPane = options.autoOpenPane === true

  // --- Recording: never block the tool -------------------------------------
  on('tool.call', { tool: 'Edit' }, ($, e, next) =>
    observe($, { tool: 'Edit', path: e.file_path, toolUseId: e.tool_use_id, agentId: e.agentId }, () => next(e)),
  ).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, ($, e, next) =>
    observe($, { tool: 'Write', path: e.file_path, toolUseId: e.tool_use_id, agentId: e.agentId }, () => next(e)),
  ).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) =>
    observe($, { tool: 'NotebookEdit', path: e.notebook_path, toolUseId: e.tool_use_id, agentId: e.agentId }, () => next(e)),
  ).catch(($, e, next) => next(e))

  // --- Lifecycle -------------------------------------------------------------
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'changes', description: "Review Claude's file changes: Keep or Undo" })
    } catch (err) {
      debug($, `/changes command not registered: ${errorText(err)}`)
    }
    try {
      await serial(() => ensureOwner($))
    } catch (err) {
      debug($, `index not reloaded: ${errorText(err)}`)
    }
    // Does not block the first prompt.
    void cleanup($, retentionDays).catch(err => debug($, `cleanup failed: ${errorText(err)}`))
    return next(e)
  })

  // /clear keeps everything: empty registry, copies deleted, files untouched.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await serial(async () => {
          // Saved copies go; undo backups stay until the periodic cleanup.
          const dir = await sessionDir($, e.sessionId)
          const reg = await read($, registry)
          await dropBlobs($, Object.values(reg.files), dir)
          await removeFiles($, [`${dir}/index.json`], dir)
          await $.store.delete(`sessions/${e.sessionId}`)
          await $.state.set(REGISTRY, EMPTY)
          await $.state.set(CONFIRM, null)
          await $.state.set(EXPANDED, null)
          await $.state.set(TURN, null)
        })
      } catch (err) {
        debug($, `cleanup after /clear failed: ${errorText(err)}`)
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    try {
      const number = await $.session.turns().catch(() => 0)
      const mark: TurnMark = { id: e.turnId, number, added: 0 }
      await $.state.set(TURN, mark)
      await reconcile($)
    } catch (err) {
      debug($, `turn.start: ${errorText(err)}`)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        const turn = await read($, turnMark)
        if (turn !== null && turn.id === e.turnId && turn.added > 0) {
          const sum = totals(await read($, registry))
          if (sum.files > 0) {
            $.ui.toast(`${filesText(sum.files)} changed by Claude pending (+${sum.added} −${sum.removed}) · /changes to review`)
            if (autoOpenPane && isFullscreen) await $.ui.open({ id: PANE, title: PANE_TITLE })
          }
        }
      } catch (err) {
        debug($, `turn.complete: ${errorText(err)}`)
      }
    }
    return next(e)
  })

  on('command.run', { command: 'changes' }, async $ => {
    await openPane($)
    const sum = totals(await read($, registry))
    return {
      text: sum.files === 0 ? 'No pending changes from Claude.' : `${filesText(sum.files)} changed by Claude pending review.`,
    }
  })

  // --- Band above the prompt -------------------------------------------------
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.viewport?.isFullscreen !== undefined) isFullscreen = e.viewport.isFullscreen
    if (e.props.hasSurvey || !(await isOwned($))) return next(e)
    const reg = await read($, registry)
    const confirm = await read($, pendingConfirm)
    if (reg.order.length === 0 && confirm === null) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const sum = totals(reg)
    return (
      <Box key="keep-or-undo" flexDirection="column">
        {confirm !== null && (
          <Box key="confirm" flexDirection="row" gap={1}>
            <Text color="warning" wrap="truncate-end">
              {confirmText(confirm, reg)}
            </Text>
            <Button key="confirm-reject" label="Undo anyway" variant="primary" onPress={() => confirmReject($)} />
            <Button key="confirm-cancel" label="Cancel" onPress={() => update($, pendingConfirm, () => null)} />
          </Box>
        )}
        {sum.files > 0 && (
          <Box key="summary" flexDirection="row" gap={1}>
            <Text>{`${filesText(sum.files)} changed by Claude ·`}</Text>
            <Text color="diffAdded">+{sum.added}</Text>
            <Text color="diffRemoved">−{sum.removed}</Text>
            <Button key="review" label="Review" onPress={() => openPane($)} />
            <Button key="accept-all" label="Keep all" onPress={async () => accept($, (await read($, registry)).order)} />
            <Button
              key="reject-all"
              label="Undo all"
              onPress={async () => reject($, (await read($, registry)).order, { isAll: true, isConfirmed: false })}
            />
          </Box>
        )}
      </Box>
    )
  })

  // --- /changes pane ---------------------------------------------------------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const isCurrent = await isOwned($)
    const reg = isCurrent ? await read($, registry) : EMPTY
    const confirm = isCurrent ? await read($, pendingConfirm) : null
    const open = await read($, expanded)
    const dir = await sessionDir($)

    const rows = []
    for (const path of reg.order) {
      const file = reg.files[path]
      if (file === undefined) continue
      const added = file.entries.reduce((n, x) => n + x.added, 0)
      const removed = file.entries.reduce((n, x) => n + x.removed, 0)
      const badges = badgesOf(file)
      const isOpen = open === path

      const sections = []
      if (isOpen) {
        for (const entry of file.entries) {
          const head = [entry.tool, entry.turnNumber !== null ? `turn ${entry.turnNumber}` : undefined, entry.agent ? `subagent ${entry.agent}` : undefined]
            .filter(Boolean)
            .join(' · ')
          const source = entry.patchRef === null ? undefined : await readBlob($, dir, entry.patchRef)
          sections.push(
            <Box key={`entry:${entry.id}`} flexDirection="column" marginLeft={2}>
              <Text dimColor>{`${head} · +${entry.added} −${entry.removed}`}</Text>
              {source !== undefined && source !== '' ? (
                <Code source={source} format="diff" path={file.displayPath} />
              ) : (
                <Text dimColor>no diff available</Text>
              )}
            </Box>,
          )
        }
        if (file.absorbedExternal) {
          sections.push(
            <Box key={`external:${path}`} marginLeft={2}>
              <Text color="warning">This file includes absorbed external changes: Undo reverts those too.</Text>
            </Box>,
          )
        }
      }

      rows.push(
        <Box key={`file:${file.displayPath}`} flexDirection="column">
          {/* Keep and Undo first: a long path or many badges must not push them past a narrow pane's edge. */}
          <Box flexDirection="row" gap={1}>
            <Button key={`accept:${file.displayPath}`} label="Keep" onPress={() => accept($, [path])} />
            <Button
              key={`reject:${file.displayPath}`}
              label="Undo"
              onPress={() => reject($, [path], { isAll: false, isConfirmed: false })}
            />
            <Box flexShrink={1}>
              <Button
                key={`open:${file.displayPath}`}
                plain
                onPress={() => update($, expanded, current => (current === path ? null : path))}
              >
                {isOpen ? '▾ ' : '▸ '}
                {file.displayPath} <Text color="diffAdded">+{added}</Text> <Text color="diffRemoved">−{removed}</Text>
                {badges.length > 0 ? <Text dimColor> [{badges.join('] [')}]</Text> : ''}
              </Button>
            </Box>
          </Box>
          {sections}
        </Box>,
      )
    }

    const sum = totals(reg)
    return (
      <Box key="keep-or-undo-pane" flexDirection="column">
        {confirm !== null && (
          <Box key="confirm" flexDirection="column">
            <Text color="warning">{confirmText(confirm, reg)}</Text>
            <Box flexDirection="row" gap={1}>
              <Button key="confirm-reject" label="Undo anyway" variant="primary" onPress={() => confirmReject($)} />
              <Button key="confirm-cancel" label="Cancel" onPress={() => update($, pendingConfirm, () => null)} />
            </Box>
          </Box>
        )}
        {sum.files === 0 ? (
          <Text dimColor>No pending changes from Claude.</Text>
        ) : (
          <Box key="totals" flexDirection="row" gap={1}>
            <Text>{`${filesText(sum.files)} ·`}</Text>
            <Text color="diffAdded">+{sum.added}</Text>
            <Text color="diffRemoved">−{sum.removed}</Text>
            <Button key="accept-all" label="Keep all" onPress={async () => accept($, (await read($, registry)).order)} />
            <Button
              key="reject-all"
              label="Undo all"
              onPress={async () => reject($, (await read($, registry)).order, { isAll: true, isConfirmed: false })}
            />
          </Box>
        )}
        {rows}
      </Box>
    )
  })
}
