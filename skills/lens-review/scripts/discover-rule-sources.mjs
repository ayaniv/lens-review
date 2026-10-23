// Finds the repo's own rule files that govern a set of files: the AGENTS.md / CLAUDE.md in
// each file's directory and its ancestors (nearest first), plus the repo-wide cursor and
// copilot rule files. Casting passes every tracked file; a review passes the changed ones.
//
//   node discover-rule-sources.mjs --repo <dir> [--files <files.txt>] [file...]
//     → JSON array of {path, kind} on stdout, paths relative to the repo
import fs from 'node:fs'
import path from 'node:path'
import { fail, isRunDirectly, readTextFile } from './lib/cli.mjs'

const ANCESTOR_RULE_FILES = { 'AGENTS.md': 'agents', 'CLAUDE.md': 'claude' }
const REPO_WIDE_RULE_FILES = [
  { path: '.cursorrules', kind: 'cursor' },
  { path: '.github/copilot-instructions.md', kind: 'copilot' },
]
const REPO_WIDE_RULE_DIRS = [
  { dir: '.cursor/rules', suffix: '.mdc', kind: 'cursor' },
  { dir: '.github/instructions', suffix: '.instructions.md', kind: 'copilot' },
]

function ancestorDirs(relativeFile) {
  const dirs = []
  for (let dir = path.posix.dirname(relativeFile); dir !== '.'; dir = path.posix.dirname(dir)) dirs.push(dir)
  dirs.push('')
  return dirs
}

function repoWideRuleSources(repoDir) {
  const singleFiles = REPO_WIDE_RULE_FILES.filter(source => fs.existsSync(path.join(repoDir, source.path)))
  const dirFiles = REPO_WIDE_RULE_DIRS.flatMap(({ dir, suffix, kind }) => {
    const absoluteDir = path.join(repoDir, dir)
    if (!fs.existsSync(absoluteDir)) return []
    return fs
      .readdirSync(absoluteDir, { recursive: true })
      .filter(entry => entry.endsWith(suffix))
      .sort()
      .map(entry => ({ path: path.posix.join(dir, entry.split(path.sep).join('/')), kind }))
  })
  return [...singleFiles, ...dirFiles]
}

export function discoverRuleSources(repoDir, files) {
  const sources = []
  const seenPaths = new Set()
  for (const file of files) {
    for (const dir of ancestorDirs(file)) {
      for (const [fileName, kind] of Object.entries(ANCESTOR_RULE_FILES)) {
        const rulePath = path.posix.join(dir, fileName)
        if (seenPaths.has(rulePath) || !fs.existsSync(path.join(repoDir, rulePath))) continue
        seenPaths.add(rulePath)
        sources.push({ path: rulePath, kind })
      }
    }
  }
  return [...sources, ...repoWideRuleSources(repoDir)]
}

function parseArgs(argv) {
  const files = []
  let repoDir = null
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--repo') repoDir = argv[++index]
    else if (argv[index] === '--files') files.push(...readTextFile(argv[++index]).split('\n').filter(Boolean))
    else files.push(argv[index])
  }
  return { repoDir, files }
}

if (isRunDirectly(import.meta.url)) {
  const { repoDir, files } = parseArgs(process.argv.slice(2))
  if (!repoDir) fail('usage: discover-rule-sources.mjs --repo <dir> [--files <files.txt>] [file...]')
  if (!fs.existsSync(repoDir)) fail(`repo not found: ${repoDir}`)
  console.log(JSON.stringify(discoverRuleSources(repoDir, files), null, 2))
}
