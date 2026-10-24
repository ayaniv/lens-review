// Map of each file the diff touches (repo-relative) → the text of every line it adds or
// removes. Context lines are left out: a line the PR didn't change says nothing about it.
// A deleted file is keyed by its old path, since it has no new one.
export function parseChangedLines(patchText) {
  const changedLines = new Map()
  let oldPath = null
  let lines = null
  for (const line of patchText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldPath = null
      lines = null
    } else if (line.startsWith('--- ')) {
      oldPath = line.match(/^--- a\/(.*)$/)?.[1] ?? null
    } else if (line.startsWith('+++ ')) {
      const filePath = line.match(/^\+\+\+ b\/(.*)$/)?.[1] ?? oldPath
      lines = filePath ? [] : null
      if (filePath) changedLines.set(filePath, lines)
    } else if (lines && (line.startsWith('+') || line.startsWith('-'))) {
      lines.push(line.slice(1))
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
  let newLine = 0
  for (const line of patchText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null
    } else if (line.startsWith('--- ')) {
      file = { path: null, isNew: line === '--- /dev/null', added: [], removed: [], hunks: [] }
    } else if (line.startsWith('+++ ') && file) {
      file.path = line.match(/^\+\+\+ b\/(.*)$/)?.[1] ?? null
      if (file.path) files.push(file)
      else file = null
    } else if (file?.path && line.startsWith('@@')) {
      const [, start, count = '1'] = line.match(/^@@ -\S+ \+(\d+)(?:,(\d+))?/) ?? [null, '0', '0']
      newLine = Number(start)
      file.hunks.push([Number(start), Number(start) + Number(count) - 1])
    } else if (file?.path && line.startsWith('+')) {
      file.added.push({ line: newLine, text: line.slice(1) })
      newLine++
    } else if (file?.path && line.startsWith('-')) {
      file.removed.push({ line: newLine, text: line.slice(1) })
    } else if (file?.path && line.startsWith(' ')) {
      newLine++
    }
  }
  return files
}
