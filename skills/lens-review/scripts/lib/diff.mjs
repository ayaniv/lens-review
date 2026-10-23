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
