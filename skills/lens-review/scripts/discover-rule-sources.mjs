// Finds the repo's own rule files that govern a set of files: the AGENTS.md / CLAUDE.md in
// each file's directory and its ancestors (nearest first), plus the repo-wide cursor and
// copilot rule files. Casting passes every tracked file; a review passes the changed ones.
//
// The developer's own taste file (e.g. ~/.claude/CLAUDE.md) joins only by opt-in, through
// --taste or LENS_REVIEW_TASTE, and comes last so the repo's own rules win a conflict.
// Nothing else outside the repo is ever read.
//
//   node discover-rule-sources.mjs --repo <dir> [--files <files.txt>] [--taste <path>] [file...]
//     → JSON array of {path, kind} on stdout, paths relative to the repo (the taste file's absolute)
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

// --taste wins over the LENS_REVIEW_TASTE default; with neither, there is no taste file.
export function resolveTastePath(tasteFlag, env) {
  const tastePath = tasteFlag || env.LENS_REVIEW_TASTE
  return tastePath ? path.resolve(tastePath) : null
}

function parseArgs(argv) {
  const files = []
  let repoDir = null
  let tasteFlag = null
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--repo') repoDir = argv[++index]
    else if (argv[index] === '--taste') tasteFlag = argv[++index]
    else if (argv[index] === '--files') files.push(...readTextFile(argv[++index]).split('\n').filter(Boolean))
    else files.push(argv[index])
  }
  return { repoDir, files, tasteFlag }
}

if (isRunDirectly(import.meta.url)) {
  const { repoDir, files, tasteFlag } = parseArgs(process.argv.slice(2))
  if (!repoDir) fail('usage: discover-rule-sources.mjs --repo <dir> [--files <files.txt>] [--taste <path>] [file...]')
  if (!fs.existsSync(repoDir)) fail(`repo not found: ${repoDir}`)
  const tastePath = resolveTastePath(tasteFlag, process.env)
  if (tastePath && !fs.existsSync(tastePath)) fail(`taste file not found: ${tastePath}`)
  const tasteSource = tastePath ? [{ path: tastePath, kind: 'taste' }] : []
  console.log(JSON.stringify([...discoverRuleSources(repoDir, files), ...tasteSource], null, 2))
}
