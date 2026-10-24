// Read-only access to the repo under review at the commit under review, for the prechecks.
// Reads go through git at that commit, so uncommitted edits in the checkout can't change a
// check's answer. A commit the repo doesn't have (a PR head never fetched) is an error, never
// a quiet fallback to whatever branch is checked out.
import { spawnSync } from 'node:child_process'

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

function filesAtCommit(repoDir, commit) {
  return gitOutput(repoDir, ['ls-tree', '-r', '--name-only', commit]).split('\n').filter(Boolean)
}

export function requireCommit(repoDir, commit) {
  if (!hasCommit(repoDir, commit)) throw new Error(`commit ${commit || '(none)'} is not in ${repoDir}; fetch it (for a PR, git fetch origin pull/<n>/head) and run again`)
  return commit
}

export function openRepo(repoDir, head) {
  const commit = requireCommit(repoDir, head)
  const contents = new Map()
  let fileList = null
  return {
    files() {
      fileList ??= filesAtCommit(repoDir, commit)
      return fileList
    },
    // Every file at another commit of the same repo, e.g. the base branch's tip.
    filesAt(otherCommit) {
      return filesAtCommit(repoDir, requireCommit(repoDir, otherCommit))
    },
    // The file's text at the commit, or null when it isn't there.
    read(filePath) {
      if (!contents.has(filePath)) contents.set(filePath, readAtCommit(repoDir, commit, filePath))
      return contents.get(filePath)
    },
    // The files holding any of `texts`, ignoring case.
    filesContainingAny(texts) {
      if (texts.length === 0) return []
      const patterns = texts.flatMap(text => ['-e', text])
      const result = runGit(repoDir, ['grep', '-l', '-I', '-F', '-i', ...patterns, commit, '--'])
      if (result.status === 1) return []
      if (result.status !== 0) throw new Error(`git grep failed in ${repoDir}: ${result.stderr.trim()}`)
      return result.stdout
        .split('\n')
        .filter(Boolean)
        .map(file => file.slice(commit.length + 1))
    },
    // Every line holding `text` as a whole word, as {file, line, text}.
    grepWord(text) {
      const result = runGit(repoDir, ['grep', '-n', '-I', '-F', '-w', '-e', text, commit, '--'])
      // Exit 1 is git grep's "no match", not a failure.
      if (result.status === 1) return []
      if (result.status !== 0) throw new Error(`git grep ${text} failed in ${repoDir}: ${result.stderr.trim()}`)
      return result.stdout
        .split('\n')
        .filter(Boolean)
        .map(match => {
          const withoutCommit = match.slice(commit.length + 1)
          const [, file, line, lineText] = withoutCommit.match(/^(.*?):(\d+):(.*)$/)
          return { file, line: Number(line), text: lineText }
        })
    },
  }
}
