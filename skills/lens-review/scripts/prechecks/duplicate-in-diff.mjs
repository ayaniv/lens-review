// duplicate-in-diff: a block the diff adds twice, in two files or two far-apart places of one
// file. Test files count only across files: a test file repeats its own arrange/act/assert
// shape by design, but a helper copied into a second test file is still a copy. Lines are normalised (names, strings and numbers become placeholders) so a copy with
// renamed variables still matches, then compared as token shingles over windows of lines.
import { isCodeFile, isFixture, isTestFile, precheckFinding } from './finding.mjs'

// A copy has to span more than this many lines: shorter shared runs are idiom, not duplication.
export const MAX_IGNORED_BLOCK_LINES = 5
const WINDOW_LINES = MAX_IGNORED_BLOCK_LINES + 1
const SHINGLE_TOKENS = 4
// Share of shingles two windows must have in common (Jaccard) to be one block copied. A copy
// with renamed variables scores ~0.9-1.0; the CLI entry boilerplate every script shares
// stays under 0.8.
const SIMILARITY_THRESHOLD = 0.85
const KEYWORDS = new Set(
  'async await break case catch class const continue default do else export for from function if import in let new of return switch this throw try typeof var while yield null undefined true false def elif except raise with pass select insert update delete where begin end loop declare'.split(' '),
)

function isComment(text) {
  return /^(\/\/|\/\*|\*|#|--)/.test(text)
}

function tokens(text) {
  return text
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ' S ')
    .match(/[A-Za-z_$][\w$]*|\d+|[^\s\w]/g)
    .map(token => (/^\d/.test(token) ? 'N' : /^[A-Za-z_$]/.test(token) && !KEYWORDS.has(token) ? 'I' : token))
}

// Each run of consecutive added code lines, as [{line, tokens}], blank and comment lines left out.
function addedBlocks(file) {
  const blocks = []
  let block = []
  let previousLine = null
  for (const { line, text } of file.added) {
    const trimmed = text.trim()
    if (previousLine !== null && line !== previousLine + 1) {
      blocks.push(block)
      block = []
    }
    previousLine = line
    if (trimmed && !isComment(trimmed)) block.push({ line, tokens: tokens(trimmed) })
  }
  blocks.push(block)
  return blocks.filter(candidate => candidate.length >= WINDOW_LINES)
}

function shingles(windowLines) {
  const flat = windowLines.flatMap(({ tokens: lineTokens }) => [...lineTokens, '\n'])
  const set = new Set()
  for (let index = 0; index + SHINGLE_TOKENS <= flat.length; index++) set.add(flat.slice(index, index + SHINGLE_TOKENS).join(' '))
  return set
}

function windowsOf(file) {
  return addedBlocks(file).flatMap(block =>
    block.slice(0, block.length - WINDOW_LINES + 1).map((_, index) => {
      const windowLines = block.slice(index, index + WINDOW_LINES)
      return { file: file.path, firstLine: windowLines[0].line, lastLine: windowLines.at(-1).line, shingles: shingles(windowLines) }
    }),
  )
}

function similarity(first, second) {
  let shared = 0
  for (const shingle of first.shingles) if (second.shingles.has(shingle)) shared++
  return shared / (first.shingles.size + second.shingles.size - shared)
}

// Two windows of one file are only copies when they don't overlap and aren't adjacent, and
// never within one test file.
function arePlacesApart(first, second) {
  if (first.file !== second.file) return true
  return !isTestFile(first.file) && second.firstLine > first.lastLine + WINDOW_LINES
}

export function duplicateInDiff({ diffFiles }) {
  const windows = diffFiles.filter(file => isCodeFile(file.path) && !isFixture(file.path)).flatMap(windowsOf)
  // One finding per pair of places: the later copy, pointing at the first window it repeats.
  const copies = new Map()
  for (let later = 0; later < windows.length; later++) {
    for (let earlier = 0; earlier < later; earlier++) {
      const [first, second] = [windows[earlier], windows[later]]
      if (!arePlacesApart(first, second) || similarity(first, second) < SIMILARITY_THRESHOLD) continue
      const key = `${first.file}→${second.file}`
      const known = copies.get(key)
      if (known && second.firstLine <= known.lastLine + 1) known.lastLine = second.lastLine
      else if (!known) copies.set(key, { first, firstLine: second.firstLine, lastLine: second.lastLine, file: second.file })
    }
  }
  return [...copies.values()].map(({ first, file, firstLine, lastLine }) =>
    precheckFinding({
      check: 'duplicate-in-diff',
      file,
      line: firstLine,
      category: 'duplication',
      duplicates: `${first.file}:${first.firstLine}`,
      description: `Lines ${firstLine}-${lastLine} repeat a block this diff also adds at ${first.file}:${first.firstLine}, with only names changed. Extract one shared function and pass what varies.`,
      rule: 'Never copy a function or logic body; extract it the moment a second call site needs it.',
    }),
  )
}
