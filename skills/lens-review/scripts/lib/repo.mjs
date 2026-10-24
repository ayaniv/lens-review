// Read-only access to the repo under review at the commit under review, for the prechecks.
// Reads go through git at that commit when the repo has it, so uncommitted edits in the
// checkout can't change a check's answer; otherwise they fall back to the working tree, and
// say so on stderr.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// git grep and ls-tree on a large repo print more than spawnSync's 1 MB default.
const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024

function runGit(repoDir, args) {
  const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER_BYTES })
  if (result.error) throw new Error(`git ${args.join(' ')} failed: ${result.error.message}`)
  return result
}

function gitOutput(repoDir, args) {
  const result = runGit(repoDir, args)
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${repoDir}: ${result.stderr.trim()}`)
  return result.stdout
}

function hasCommit(repoDir, commit) {
  return Boolean(commit) && runGit(repoDir, ['cat-file', '-e', `${commit}^{commit}`]).status === 0
}

function readAtCommit(repoDir, commit, filePath) {
  const result = runGit(repoDir, ['show', `${commit}:${filePath}`])
  return result.status === 0 ? result.stdout : null
}

function readWorkingTree(repoDir, filePath) {
  try {
    return fs.readFileSync(path.join(repoDir, filePath), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error(`cannot read ${filePath} in ${repoDir}: ${error.message}`)
  }
}

export function openRepo(repoDir, head) {
  const commit = hasCommit(repoDir, head) ? head : null
  if (!commit) console.error(`lens-review: precheck reads the working tree of ${repoDir}: commit ${head || '(none)'} is not in it`)
  const contents = new Map()
  let fileList = null
  return {
    files() {
      fileList ??= gitOutput(repoDir, commit ? ['ls-tree', '-r', '--name-only', commit] : ['ls-files']).split('\n').filter(Boolean)
      return fileList
    },
    // The file's text at the commit, or null when it isn't there.
    read(filePath) {
      if (!contents.has(filePath)) contents.set(filePath, commit ? readAtCommit(repoDir, commit, filePath) : readWorkingTree(repoDir, filePath))
      return contents.get(filePath)
    },
    // The files holding any of `texts`, ignoring case.
    filesContainingAny(texts) {
      if (texts.length === 0) return []
      const patterns = texts.flatMap(text => ['-e', text])
      const result = runGit(repoDir, ['grep', '-l', '-I', '-F', '-i', ...patterns, ...(commit ? [commit] : []), '--'])
      if (result.status === 1) return []
      if (result.status !== 0) throw new Error(`git grep failed in ${repoDir}: ${result.stderr.trim()}`)
      return result.stdout
        .split('\n')
        .filter(Boolean)
        .map(file => (commit ? file.slice(commit.length + 1) : file))
    },
    // Every line holding `text` as a whole word, as {file, line, text}.
    grepWord(text) {
      const result = runGit(repoDir, ['grep', '-n', '-I', '-F', '-w', '-e', text, ...(commit ? [commit] : []), '--'])
      // Exit 1 is git grep's "no match", not a failure.
      if (result.status === 1) return []
      if (result.status !== 0) throw new Error(`git grep ${text} failed in ${repoDir}: ${result.stderr.trim()}`)
      return result.stdout
        .split('\n')
        .filter(Boolean)
        .map(match => {
          const withoutCommit = commit ? match.slice(commit.length + 1) : match
          const [, file, line, lineText] = withoutCommit.match(/^(.*?):(\d+):(.*)$/)
          return { file, line: Number(line), text: lineText }
        })
    },
  }
}
