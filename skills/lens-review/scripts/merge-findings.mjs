// Merges the reviewer agents' findings into one list: the same issue flagged by several
// reviewers becomes one finding with the highest severity and every reviewer's name.
// Findings that don't point into the diff under review are dropped, not merged.
//
//   node merge-findings.mjs --diff <diff.patch> <findings.json>...   → merged JSON array on stdout
import { fail, isRunDirectly, readJsonArrayFile, readTextFile, reportDropped } from './lib/cli.mjs'

// Two findings in the same file and category are one issue when their lines are this close.
export const DEDUP_LINE_WINDOW = 3

export const SEVERITIES = ['must', 'should', 'suggestion']

export function normalizeCategory(category) {
  return category.trim().toLowerCase()
}

// Map of each file the diff leaves in place (repo-relative) → its new-side hunk ranges.
// Deleted files are absent: there is no new side to cite.
export function parseDiffLines(patchText) {
  const diffLines = new Map()
  let ranges = null
  for (const line of patchText.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(.*)$/)
    if (fileMatch) {
      ranges = []
      diffLines.set(fileMatch[1], ranges)
    } else if (line.startsWith('+++ ') || line.startsWith('diff --git ')) {
      ranges = null
    } else if (ranges) {
      const hunkMatch = line.match(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/)
      if (hunkMatch) {
        const start = Number(hunkMatch[1])
        const count = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2])
        if (count > 0) ranges.push([start, start + count - 1])
      }
    }
  }
  return diffLines
}

// Reviewers sometimes cite the absolute path of the checkout they read; map it back onto the
// changed file it ends with, so it dedups against everyone else's repo-relative path.
function toDiffFile(file, diffLines) {
  const relative = file.replace(/^\.\//, '')
  if (diffLines.has(relative)) return relative
  if (!file.startsWith('/')) return null
  const suffixMatches = [...diffLines.keys()].filter(diffFile => file.endsWith(`/${diffFile}`))
  return suffixMatches.sort((first, second) => second.length - first.length)[0] ?? null
}

// True when `line` of the repo-relative `file` falls inside one of the diff's new-side hunks.
export function isLineInDiff(diffLines, file, line) {
  return diffLines.get(file)?.some(([start, end]) => line >= start && line <= end) ?? false
}

function outsideDiffReason(finding, diffLines) {
  const diffFile = toDiffFile(finding.file, diffLines)
  if (!diffFile) return `${finding.file} is not a file this diff changes`
  if (!isLineInDiff(diffLines, diffFile, finding.line)) return `line ${finding.line} is outside the diff of ${diffFile}`
  return null
}

function malformedReason(finding) {
  if (!finding || typeof finding !== 'object') return 'not an object'
  if (typeof finding.file !== 'string' || !finding.file) return 'missing file'
  if (!Number.isInteger(finding.line) || finding.line < 1) return 'missing or invalid line'
  if (!SEVERITIES.includes(finding.severity)) return `unknown severity "${finding.severity}"`
  if (typeof finding.category !== 'string' || !finding.category.trim()) return 'missing category'
  if (typeof finding.description !== 'string' || !finding.description) return 'missing description'
  if (typeof finding.reviewer !== 'string' || !finding.reviewer) return 'missing reviewer'
  return null
}

// A reviewer never reports one issue twice, so a merged finding takes at most one finding
// per reviewer: two findings from the same reviewer on the same line are two issues.
function isSameIssue(merged, finding) {
  return (
    merged.file === finding.file &&
    normalizeCategory(merged.category) === normalizeCategory(finding.category) &&
    Math.abs(merged.line - finding.line) <= DEDUP_LINE_WINDOW &&
    !merged.reviewers.includes(finding.reviewer)
  )
}

function words(finding) {
  return new Set(`${finding.rule ?? ''} ${finding.description}`.toLowerCase().match(/[a-z0-9#]{3,}/g) ?? [])
}

function sharedWordCount(first, second) {
  const secondWords = words(second)
  return [...words(first)].filter(word => secondWords.has(word)).length
}

// Several issues can sit on one line (a raw <button> and its hardcoded color), so pick the
// one this finding describes rather than whichever was merged first.
function closestIssue(candidates, finding) {
  return candidates.reduce(
    (best, candidate) => (sharedWordCount(candidate, finding) > sharedWordCount(best, finding) ? candidate : best),
    candidates[0],
  )
}

function higherSeverity(first, second) {
  return SEVERITIES.indexOf(first) <= SEVERITIES.indexOf(second) ? first : second
}

export function mergeFindings(findingsPerReviewer, diffLines) {
  const findings = []
  const dropped = []
  for (const rawFinding of findingsPerReviewer.flat()) {
    const reason = malformedReason(rawFinding) ?? outsideDiffReason(rawFinding, diffLines)
    if (reason) {
      dropped.push({ item: rawFinding, reason })
      continue
    }
    const finding = { ...rawFinding, file: toDiffFile(rawFinding.file, diffLines) }
    const { reviewer, ...issue } = finding
    const candidates = findings.filter(merged => isSameIssue(merged, finding))
    const existing = candidates.length > 0 ? closestIssue(candidates, finding) : null
    if (existing) {
      existing.severity = higherSeverity(existing.severity, finding.severity)
      existing.reviewers.push(reviewer)
      existing.duplicates ??= finding.duplicates
    } else {
      findings.push({ id: `F${findings.length + 1}`, ...issue, reviewers: [reviewer] })
    }
  }
  return { findings, dropped }
}

if (isRunDirectly(import.meta.url)) {
  const usage = 'usage: merge-findings.mjs --diff <diff.patch> <findings.json>...'
  const [flag, diffPath, ...findingsPaths] = process.argv.slice(2)
  if (flag !== '--diff' || !diffPath) fail(`${usage} (--diff is required: findings are checked against it)`)
  if (findingsPaths.length === 0) fail(`${usage} (no findings files given)`)
  const patchText = readTextFile(diffPath)
  // Every path below is matched against the b/ side; a patch without prefixes would silently
  // drop every finding as "not a file this diff changes".
  if (/^\+\+\+ (?!b\/|\/dev\/null)/m.test(patchText)) {
    fail(`${diffPath} has file headers without the b/ prefix; regenerate it with --src-prefix=a/ --dst-prefix=b/`)
  }
  const diffLines = parseDiffLines(patchText)
  const { findings, dropped } = mergeFindings(findingsPaths.map(readJsonArrayFile), diffLines)
  reportDropped('findings', dropped)
  console.log(JSON.stringify(findings, null, 2))
}
