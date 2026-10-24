// Walks a unified diff and yields what each line is. Inside a hunk the @@ header's line counts
// decide where it ends, so a hunk line that looks like a file header (a removed SQL comment
// `-- x` is `--- x`, an added `++ x` is `+++ x`) still counts as a hunk line. A line no hunk
// line can start with (`diff --git`, say) ends the hunk early, for a patch whose counts are off.
//   {kind: 'file', oldPath, newPath}  (null for /dev/null)
//   {kind: 'hunk', newStart, newCount}
//   {kind: 'add' | 'remove' | 'context', text, newLine}  (a removal's newLine is the line it sat before)
export function* walkDiff(patchText) {
  let oldPath = null
  let oldRemaining = 0
  let newRemaining = 0
  let newLine = 0
  for (const line of patchText.split('\n')) {
    const isHunkLine = line === '' || '+- \\'.includes(line[0])
    if ((oldRemaining > 0 || newRemaining > 0) && !isHunkLine) {
      oldRemaining = 0
      newRemaining = 0
    }
    if (oldRemaining > 0 || newRemaining > 0) {
      if (line.startsWith('\\')) continue
      const marker = line[0]
      const text = line.slice(1)
      if (marker === '+') {
        yield { kind: 'add', text, newLine }
        newLine++
        newRemaining--
      } else if (marker === '-') {
        yield { kind: 'remove', text, newLine }
        oldRemaining--
      } else {
        // A context line, or an empty one where a tool trimmed the leading space.
        yield { kind: 'context', text, newLine }
        newLine++
        oldRemaining--
        newRemaining--
      }
      continue
    }
    const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (line.startsWith('--- ')) {
      oldPath = line.match(/^--- a\/(.*)$/)?.[1] ?? null
    } else if (line.startsWith('+++ ')) {
      yield { kind: 'file', oldPath, newPath: line.match(/^\+\+\+ b\/(.*)$/)?.[1] ?? null }
    } else if (hunk) {
      const [, oldCount = '1', newStart, newCount = '1'] = hunk
      oldRemaining = Number(oldCount)
      newRemaining = Number(newCount)
      newLine = Number(newStart)
      yield { kind: 'hunk', newStart: Number(newStart), newCount: Number(newCount) }
    } else if (line.startsWith('diff --git ')) {
      oldPath = null
    }
  }
}

// Map of each file the diff touches (repo-relative) → the text of every line it adds or
// removes. Context lines are left out: a line the PR didn't change says nothing about it.
// A deleted file is keyed by its old path, since it has no new one.
export function parseChangedLines(patchText) {
  const changedLines = new Map()
  let lines = null
  for (const event of walkDiff(patchText)) {
    if (event.kind === 'file') {
      const filePath = event.newPath ?? event.oldPath
      lines = filePath ? [] : null
      if (filePath) changedLines.set(filePath, lines)
    } else if (lines && (event.kind === 'add' || event.kind === 'remove')) {
      lines.push(event.text)
    }
  }
  return changedLines
}

// Each file the diff touches, for checks that need line numbers: `added` holds every added
// line with its new-side number, `removed` every removed line with the new-side line it sat
// before (a removal leaves no line of its own), `hunks` each hunk's new-side [first, last].
// Deleted files are left out: no new side.
export function parseDiffFiles(patchText) {
  const files = []
  let file = null
  for (const event of walkDiff(patchText)) {
    if (event.kind === 'file') {
      file = event.newPath ? { path: event.newPath, isNew: event.oldPath === null, added: [], removed: [], hunks: [] } : null
      if (file) files.push(file)
    } else if (!file) {
      continue
    } else if (event.kind === 'hunk') {
      file.hunks.push([event.newStart, event.newStart + event.newCount - 1])
    } else if (event.kind === 'add') {
      file.added.push({ line: event.newLine, text: event.text })
    } else if (event.kind === 'remove') {
      file.removed.push({ line: event.newLine, text: event.text })
    }
  }
  return files
}
