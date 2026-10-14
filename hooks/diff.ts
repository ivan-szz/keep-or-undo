// Diffs and counts, with no dependencies: the module has no Node.

export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: readonly string[]
}

export type Counted = { added: number; removed: number }

/** Sums the '+' and '-' lines of the engine's patches. */
export function countPatch(patch: readonly Hunk[]): Counted {
  let added = 0
  let removed = 0
  for (const hunk of patch) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  return { added, removed }
}

/** The patches as unified text, which `Code format="diff"` reads. */
export function formatPatch(patch: readonly Hunk[]): string {
  return patch
    .map(h => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n'))
    .join('\n')
}

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

// Above this threshold (lines × lines of the changed span) no LCS:
// the whole span counts as removed and then added.
const LCS_LIMIT = 4_000_000

/**
 * A line diff between two texts, as a single hunk with 3 lines of context.
 * Used where the engine gives no patch: NotebookEdit, a Write that creates.
 */
export function diffText(before: string, after: string): Hunk[] {
  const a = splitLines(before)
  const b = splitLines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  if (midA.length === 0 && midB.length === 0) return []

  const ops: string[] = []
  if (midA.length * midB.length <= LCS_LIMIT) {
    const n = midA.length
    const m = midB.length
    // One flat buffer, row i at i * width: no object per row.
    const width = m + 1
    const table = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i -= 1) {
      const row = i * width
      const below = row + width
      for (let j = m - 1; j >= 0; j -= 1) {
        table[row + j] = midA[i] === midB[j] ? table[below + j + 1]! + 1 : Math.max(table[below + j]!, table[row + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push(` ${midA[i]}`)
        i += 1
        j += 1
      } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
        ops.push(`-${midA[i]}`)
        i += 1
      } else {
        ops.push(`+${midB[j]}`)
        j += 1
      }
    }
    while (i < n) ops.push(`-${midA[i++]}`)
    while (j < m) ops.push(`+${midB[j++]}`)
  } else {
    for (const line of midA) ops.push(`-${line}`)
    for (const line of midB) ops.push(`+${line}`)
  }

  const before3 = a.slice(Math.max(0, head - 3), head).map(l => ` ${l}`)
  const after3 = a.slice(a.length - tail, Math.min(a.length, a.length - tail + 3)).map(l => ` ${l}`)
  const lines = [...before3, ...ops, ...after3]
  const start = head - before3.length
  const oldLines = lines.filter(l => !l.startsWith('+')).length
  const newLines = lines.filter(l => !l.startsWith('-')).length
  return [
    {
      oldStart: oldLines === 0 ? start : start + 1,
      oldLines,
      newStart: newLines === 0 ? start : start + 1,
      newLines,
      lines,
    },
  ]
}

/** "3", "3–5", "2, 4–6": the turn numbers for the message to the model. */
export function turnRange(numbers: readonly (number | null)[]): string {
  const sorted = [...new Set(numbers.filter((n): n is number => n !== null))].sort((x, y) => x - y)
  const parts: string[] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j += 1
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`)
    i = j + 1
  }
  return parts.join(', ')
}
