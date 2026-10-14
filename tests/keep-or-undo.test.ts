import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BAND_PROPS, DATA, PANE_PROPS, PLUGIN, ROOT, index, setup } from './harness'

const A = `${ROOT}/a.txt`

function edit(path: string, oldString: string, newString: string, agentId?: string) {
  return { tool: 'Edit', file_path: path, old_string: oldString, new_string: newString, ...(agentId ? { agentId } : {}) } as never
}

function write(path: string, content: string) {
  return { tool: 'Write', file_path: path, content } as never
}

function pane($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'keep-or-undo', props: PANE_PROPS })
}

test('1. Edit on a file with uncommitted changes: counts only Claude, Undo returns to the prior state', async ($, on) => {
  // HEAD would have "one"; the working tree already has "one\ntwo\n" uncommitted.
  const w = setup(on, { [A]: 'one\ntwo\n' })
  await $.tool.call(edit(A, 'two', 'TWO\nthree'))
  const reg = index(w)
  const file = reg.files[A]!
  expect(file.entries).toHaveLength(1)
  expect(file.entries[0]!.added).toBe(2)
  expect(file.entries[0]!.removed).toBe(1)
  expect(file.displayPath).toBe('a.txt')

  const ui = await pane($)
  await ui.press({ key: 'reject:a.txt' })
  expect(w.files.get(A)).toBe('one\ntwo\n')
  expect(index(w).order).toHaveLength(0)
  await ui.unmount()
})

test('2. Write that creates a file: Undo deletes it', async ($, on) => {
  const w = setup(on)
  const B = `${ROOT}/src/new.ts`
  await $.tool.call(write(B, 'export const x = 1\n'))
  const file = index(w).files[B]!
  expect(file.createdByClaude).toBe(true)
  expect(file.baseRef).toBe(null)
  expect(file.entries[0]!.added).toBe(1)

  const ui = await pane($)
  await ui.press({ key: 'reject:src/new.ts' })
  expect(w.files.has(B)).toBe(false)
  expect(w.rm).toContainEqual(['rm', '--', B])
  await ui.unmount()
})

test('3. Two Edits on the same file: one row, summed counts, Undo returns to before the first', async ($, on) => {
  const w = setup(on, { [A]: 'a\nb\nc\n' })
  await $.tool.call(edit(A, 'a', 'A'))
  await $.tool.call(edit(A, 'c', 'C'))
  const reg = index(w)
  expect(reg.order).toEqual([A])
  expect(reg.files[A]!.entries).toHaveLength(2)
  expect(reg.files[A]!.absorbedExternal).toBe(false)

  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'open:a.txt' }))?.text).toContain('+2')
  await ui.press({ key: 'reject:a.txt' })
  expect(w.files.get(A)).toBe('a\nb\nc\n')
  await ui.unmount()
})

test('4. Edit, manual change, Edit: absorbedExternal and Undo returns to baseRef', async ($, on) => {
  const w = setup(on, { [A]: 'a\nb\nc\n' })
  await $.tool.call(edit(A, 'a', 'A'))
  w.files.set(A, 'A\nb\nc\nmanual\n') // the user
  await $.tool.call(edit(A, 'c', 'C'))
  const file = index(w).files[A]!
  expect(file.absorbedExternal).toBe(true)
  expect(file.entries).toHaveLength(2)

  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'open:a.txt' }))?.text).toContain('includes external changes')
  // The current content is the last Edit's: no confirmation.
  await ui.press({ key: 'reject:a.txt' })
  expect(w.files.get(A)).toBe('a\nb\nc\n')
  await ui.unmount()
})

test('5. Edit followed by a manual change: Undo asks for confirmation and saves a backup', async ($, on) => {
  const w = setup(on, { [A]: 'a\n' })
  await $.tool.call(edit(A, 'a', 'A'))
  w.files.set(A, 'A\nmanual\n')

  const ui = await pane($)
  await ui.press({ key: 'reject:a.txt' })
  // Nothing touched yet: the inline confirmation is up.
  expect(w.files.get(A)).toBe('A\nmanual\n')
  expect((await ui.find({ type: 'Text', text: /later changes not made by Claude/ }))).toBeDefined()

  await ui.press({ key: 'confirm-cancel' })
  expect(await ui.find({ type: 'Text', text: /later changes/ })).toBe(undefined)
  expect(index(w).order).toEqual([A])

  await ui.press({ key: 'reject:a.txt' })
  await ui.press({ key: 'confirm-reject' })
  expect(w.files.get(A)).toBe('a\n')
  const backups = [...w.files.entries()].filter(([p]) => p.startsWith(`${DATA}/blobs/backup-`))
  expect(backups).toHaveLength(1)
  expect(backups[0]![1]).toBe('A\nmanual\n')
  expect(index(w).order).toHaveLength(0)
  await ui.unmount()
})

test('6. A file never touched by Claude and changed by hand never shows up', async ($, on) => {
  const w = setup(on, { [A]: 'a\n', [`${ROOT}/b.txt`]: 'b\n' })
  await $.tool.call(edit(A, 'a', 'A'))
  w.files.set(`${ROOT}/b.txt`, 'B by hand\n')
  await $.tool.call(edit(A, 'A', 'AA'))
  expect(index(w).order).toEqual([A])
  const ui = await pane($)
  expect(await ui.find({ key: 'open:b.txt' })).toBe(undefined)
  await ui.unmount()
})

test('7. Keep does not write to the file and deletes the copies', async ($, on) => {
  const w = setup(on, { [A]: 'a\n' })
  await $.tool.call(edit(A, 'a', 'A'))
  const blobs = () => [...w.files.keys()].filter(p => p.startsWith(`${DATA}/blobs/`))
  expect(blobs().length).toBeGreaterThan(0)
  const before = w.writes.filter(p => p === A).length

  const ui = await pane($)
  await ui.press({ key: 'accept:a.txt' })
  expect(w.writes.filter(p => p === A).length).toBe(before)
  expect(w.files.get(A)).toBe('A\n')
  expect(blobs()).toHaveLength(0)
  expect(index(w).order).toHaveLength(0)
  await ui.unmount()
})

test('8. A result with staged: true records nothing', async ($, on) => {
  const w = setup(on, { [A]: 'a\n' })
  w.extra = { staged: true }
  const r = await $.tool.call(edit(A, 'a', 'A'))
  expect(r.isError).toBe(undefined)
  expect(w.files.get(A)).toBe('a\n')
  expect(index(w).order).toHaveLength(0)
})

test('9. An Edit made by a subagent has the badge', async ($, on) => {
  const w = setup(on, { [A]: 'a\n' })
  w.agents = [{ id: 'agent-123', type: 'Explore', description: 'search' }]
  await $.tool.call(edit(A, 'a', 'A', 'agent-123'))
  expect(index(w).files[A]!.entries[0]!.agent).toBe('Explore')
  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'open:a.txt' }))?.text).toContain('subagent: Explore')
  await ui.unmount()
})

test('10. session.end with reason clear: empty registry, files untouched, backups kept', async ($, on) => {
  const w = setup(on, { [A]: 'a\n', [`${ROOT}/b.txt`]: 'b\n' })
  await $.tool.call(edit(A, 'a', 'A'))
  w.files.set(A, 'A\nmanual\n')
  const ui = await pane($)
  await ui.press({ key: 'reject:a.txt' })
  await ui.press({ key: 'confirm-reject' })
  expect(w.toasts.some(t => t.includes(`${DATA}/blobs/backup-`))).toBe(true)
  await $.tool.call(edit(`${ROOT}/b.txt`, 'b', 'B'))
  expect(index(w).order).toEqual([`${ROOT}/b.txt`])

  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } } as never)
  expect(w.files.get(`${ROOT}/b.txt`)).toBe('B\n')
  const left = [...w.files.keys()].filter(p => p.startsWith(`${DATA}/`))
  expect(left).toHaveLength(1)
  expect(left[0]).toContain('/blobs/backup-')
  expect(await ui.find({ type: 'Text', text: /No pending changes from Claude/ })).toBeDefined()
  await ui.unmount()
})

test('11. The band is drawn on terminal and on desktop', async ($, on) => {
  const w = setup(on, { [A]: 'a\nb\n' })
  await $.tool.call(edit(A, 'a', 'A'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND_PROPS } as never)
    expect(await ui.find({ type: 'Text', text: /1 file changed by Claude/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'review' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'accept-all' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'reject-all' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS } as never)
  await ui.press({ key: 'reject-all' })
  expect(w.files.get(A)).toBe('a\nb\n')
  // After the undo the band has nothing left to show.
  expect(await ui.find({ type: 'Button', key: 'reject-all' })).toBe(undefined)
  await ui.unmount()
})

test('Undo notifies the model; Undo all sends a single message with the list', async ($, on) => {
  const session = mock.session(on)
  const w = setup(on, { [A]: 'a\n', [`${ROOT}/b.txt`]: 'b\n' })
  await $.turn.start({ text: 'go', turnId: 'T1' } as never)
  await $.tool.call(edit(A, 'a', 'A'))
  const ui = await pane($)
  await ui.press({ key: 'reject:a.txt' })
  const first = session.appended().map(r => JSON.stringify(r.message.content))
  expect(first).toHaveLength(1)
  expect(first[0]).toContain('a.txt')
  expect(first[0]).toContain('turn 1')
  expect(first[0]).toContain('Re-read it')

  w.turns = 2
  await $.turn.start({ text: 'again', turnId: 'T2' } as never)
  await $.tool.call(edit(A, 'a', 'A'))
  await $.tool.call(edit(`${ROOT}/b.txt`, 'b', 'B'))
  await ui.press({ key: 'reject-all' })
  const rows = session.appended()
  expect(rows).toHaveLength(2)
  const text = JSON.stringify(rows[1]!.message.content)
  expect(text).toContain('a.txt')
  expect(text).toContain('b.txt')
  expect(w.files.get(A)).toBe('a\n')
  expect(w.files.get(`${ROOT}/b.txt`)).toBe('b\n')
  await ui.unmount()
})

test('After a --resume the registry is reloaded from index.json', async ($, on) => {
  const w = setup(on, { [A]: 'A\n' })
  w.files.set(`${DATA}/index.json`, JSON.stringify({
    updatedAt: 1_700_000_000_000,
    registry: {
      order: [A],
      files: {
        [A]: {
          realPath: A, displayPath: 'a.txt', baseRef: 'x.pre.txt', createdByClaude: false, absorbedExternal: false, tooLarge: false,
          entries: [{ id: 'x', turnId: 'T1', turnNumber: 1, tool: 'Edit', createdFile: false, preRef: 'x.pre.txt', postRef: 'x.post.txt', patchRef: null, added: 1, removed: 1, at: 1 }],
        },
      },
    },
  }))
  w.files.set(`${DATA}/blobs/x.pre.txt`, 'a\n')
  w.files.set(`${DATA}/blobs/x.post.txt`, 'A\n')
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  const ui = await pane($)
  expect(await ui.find({ type: 'Button', key: 'open:a.txt' })).toBeDefined()
  await ui.press({ key: 'reject:a.txt' })
  expect(w.files.get(A)).toBe('a\n')
  await ui.unmount()
})

test('A file over 4 MiB is recorded but undo is not available', async ($, on) => {
  const w = setup(on, { [A]: 'a\n' })
  w.tooBig.add(A)
  w.extra = { originalFile: null }
  await $.tool.call(edit(A, 'a', 'A'))
  const file = index(w).files[A]!
  expect(file.tooLarge).toBe(true)
  expect(file.entries[0]!.added).toBe(1)
  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'open:a.txt' }))?.text).toContain('too large')
  await ui.press({ key: 'reject:a.txt' })
  expect(w.files.get(A)).toBe('A\n')
  expect(w.toasts.some(t => t.includes('too large'))).toBe(true)
  await ui.unmount()
})

test('A toast at the end of the turn, only if the turn recorded changes', async ($, on) => {
  const w = setup(on, { [A]: 'a\n' })
  await $.turn.start({ text: 'nothing', turnId: 'T1' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' } as never)
  expect(w.toasts).toHaveLength(0)
  await $.turn.start({ text: 'change', turnId: 'T2' } as never)
  await $.tool.call(edit(A, 'a', 'A'))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'T2', reason: 'answer' } as never)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('/changes')
})

test('A file back at baseRef (as after /rewind) leaves the registry on the next turn', async ($, on) => {
  const w = setup(on, { [A]: 'a\n' })
  await $.tool.call(edit(A, 'a', 'A'))
  w.files.set(A, 'a\n')
  await $.turn.start({ text: 'after the rewind', turnId: 'T2' } as never)
  expect(index(w).order).toHaveLength(0)
})

test('A kept file changed again starts over from the kept state', async ($, on) => {
  const w = setup(on, { [A]: 'a\n' })
  await $.tool.call(edit(A, 'a', 'A'))
  const ui = await pane($)
  await ui.press({ key: 'accept:a.txt' })
  await $.tool.call(edit(A, 'A', 'AA'))
  await ui.press({ key: 'reject:a.txt' })
  expect(w.files.get(A)).toBe('A\n')
  await ui.unmount()
})

test('Created by Claude, deleted by hand, rewritten: stays createdByClaude and Undo deletes it', async ($, on) => {
  const w = setup(on)
  await $.tool.call(write(A, 'one\n'))
  w.files.delete(A)
  await $.tool.call(write(A, 'two\n'))
  const file = index(w).files[A]!
  expect(file.createdByClaude).toBe(true)
  expect(file.absorbedExternal).toBe(true)
  const ui = await pane($)
  await ui.press({ key: 'reject:a.txt' })
  expect(w.files.has(A)).toBe(false)
  await ui.unmount()
})

test('/changes opens the pane', async ($, on) => {
  const w = setup(on, { [A]: 'a\n' })
  await $.tool.call(edit(A, 'a', 'A'))
  const r = await $.command.run({ command: 'changes', args: '' } as never)
  expect(w.opened).toEqual(['keep-or-undo'])
  expect(r.text).toContain('1 file')
})

test('Opening a row shows the diff', async ($, on) => {
  const w = setup(on, { [A]: 'a\nb\n' })
  await $.tool.call(edit(A, 'a', 'A'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await pane($, surface)
    await ui.press({ key: 'open:a.txt' })
    const code = await ui.find({ type: 'Code' })
    expect(code?.text).toContain('-a')
    expect(code?.text).toContain('+A')
    await ui.press({ key: 'open:a.txt' })
    expect(await ui.find({ type: 'Code' })).toBe(undefined)
    await ui.unmount()
  }
  expect(index(w).order).toHaveLength(1)
})

test('NotebookEdit: counts on the cell, repeated edits without false externals, Undo restores', async ($, on) => {
  const NB = `${ROOT}/n.ipynb`
  const original = JSON.stringify({ c0: 'print(1)\nprint(2)' }, null, 1)
  const w = setup(on, { [NB]: original })
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: NB, cell_id: 'c0', new_source: 'print(1)\nprint(3)' } as never)
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: NB, cell_id: 'c0', new_source: 'print(4)\nprint(3)' } as never)
  const file = index(w).files[NB]!
  expect(file.entries).toHaveLength(2)
  expect(file.entries[0]!.added).toBe(1)
  expect(file.entries[0]!.removed).toBe(1)
  expect(file.absorbedExternal).toBe(false)
  const ui = await pane($)
  await ui.press({ key: 'reject:n.ipynb' })
  expect(w.files.get(NB)).toBe(original)
  await ui.unmount()
})

test('A NotebookEdit that reports an error, or an edit that leaves the file unchanged, records nothing', async ($, on) => {
  const NB = `${ROOT}/n.ipynb`
  const w = setup(on, { [NB]: JSON.stringify({ c0: 'print(1)' }, null, 1), [A]: 'a\n' })
  w.extra = { error: 'Cell with ID "c9" not found in notebook.' }
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: NB, cell_id: 'c9', new_source: 'print(2)' } as never)
  await $.tool.call(edit(A, 'a', 'a'))
  expect(index(w).order).toHaveLength(0)
  expect([...w.files.keys()].filter(p => p.startsWith(`${DATA}/blobs/`))).toHaveLength(0)
})

test('Undo all keeps one backup per file even when two paths share a safe name', async ($, on) => {
  const X = `${ROOT}/src/a.ts`
  const Y = `${ROOT}/src_a.ts`
  const w = setup(on, { [X]: 'x\n', [Y]: 'y\n' })
  await $.tool.call(edit(X, 'x', 'X'))
  await $.tool.call(edit(Y, 'y', 'Y'))
  w.files.set(X, 'X\nmanual x\n')
  w.files.set(Y, 'Y\nmanual y\n')

  const ui = await pane($)
  await ui.press({ key: 'reject-all' })
  await ui.press({ key: 'confirm-reject' })
  expect(w.files.get(X)).toBe('x\n')
  expect(w.files.get(Y)).toBe('y\n')
  const backups = [...w.files.entries()].filter(([p]) => p.startsWith(`${DATA}/blobs/backup-`)).map(([, text]) => text)
  expect(backups.sort()).toEqual(['X\nmanual x\n', 'Y\nmanual y\n'])
  await ui.unmount()
})

test('Session change (/resume): the registry follows the current session', async ($, on) => {
  const w = setup(on, { [A]: 'a\n', [`${ROOT}/b.txt`]: 'b\n' })
  await $.tool.call(edit(A, 'a', 'A'))
  await $.session.end({ reason: 'resume', sessionId: 'S1', resume: { id: 'S1' } } as never)

  w.sessionId = 'S2'
  await $.turn.start({ text: 'in S2', turnId: 'T9' } as never)
  const ui = await pane($)
  expect(await ui.find({ type: 'Button', key: 'open:a.txt' })).toBe(undefined)
  await $.tool.call(edit(`${ROOT}/b.txt`, 'b', 'B'))
  expect(await ui.find({ type: 'Button', key: 'open:b.txt' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'open:a.txt' })).toBe(undefined)

  w.sessionId = 'S1'
  await $.turn.start({ text: 'back in S1', turnId: 'T10' } as never)
  expect(await ui.find({ type: 'Button', key: 'open:a.txt' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'open:b.txt' })).toBe(undefined)
  await ui.press({ key: 'reject:a.txt' })
  expect(w.files.get(A)).toBe('a\n')
  expect(w.files.get(`${ROOT}/b.txt`)).toBe('B\n')
  await ui.unmount()
})
