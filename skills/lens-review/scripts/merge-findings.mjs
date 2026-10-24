// Merges the reviewer agents' findings into one list: the same issue flagged by several
// reviewers becomes one finding with the highest severity and every reviewer's name, and
// one duplicated helper flagged at each of its copies becomes one finding listing them all.
// Findings that don't point into the diff under review are dropped, not merged.
//
//   node merge-findings.mjs --diff <diff.patch> <findings.json>...   → merged JSON array on stdout
import { fail, isRunDirectly, readJsonArrayFile, readTextFile, reportDropped } from './lib/cli.mjs'
import { walkDiff } from './lib/diff.mjs'

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
  for (const event of walkDiff(patchText)) {
    if (event.kind === 'file') {
      ranges = event.newPath ? [] : null
      if (ranges) diffLines.set(event.newPath, ranges)
    } else if (ranges && event.kind === 'hunk' && event.newCount > 0) {
      ranges.push([event.newStart, event.newStart + event.newCount - 1])
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

// Two reviewers can file one issue under different categories (a lookup bug as correctness
// and as reliability); naming the same code at the same spot ties them together instead.
const MIN_SHARED_CODE_NAMES = 2

function codeNames(finding) {
  return new Set(finding.description.match(HELPER_NAME_RE) ?? [])
}

function sharedCodeNameCount(first, second) {
  const secondNames = codeNames(second)
  return [...codeNames(first)].filter(name => secondNames.has(name)).length
}

// A reviewer never reports one issue twice, so a merged finding takes at most one finding
// per reviewer: two findings from the same reviewer on the same line are two issues.
function isSameIssue(merged, finding) {
  return (
    merged.file === finding.file &&
    (normalizeCategory(merged.category) === normalizeCategory(finding.category) ||
      sharedCodeNameCount(merged, finding) >= MIN_SHARED_CODE_NAMES) &&
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

const DUPLICATION_CATEGORY = 'duplication'
// camelCase and snake_case code names: how a description names the helper it says is copied.
const HELPER_NAME_RE = /\b(?:[a-z][a-z0-9]*[A-Z]\w*|[a-z][a-z0-9]*_[a-z0-9_]+)\b/g

// What ties duplication findings into one issue: a file they share (where a copy sits, or
// the existing code it copies) or a helper they both name. A helper copied into three files
// is one fix, so it becomes one finding that lists every copy, not one comment per copy.
function duplicationKeys(finding) {
  const files = [finding.file, finding.duplicates?.split(':')[0].replace(/^\.\//, '')].filter(Boolean)
  const helpers = finding.description.match(HELPER_NAME_RE) ?? []
  return [...files.map(file => `file:${file}`), ...helpers.map(helper => `helper:${helper}`)]
}

function toLocation({ file, line, duplicates, description }) {
  return { file, line, ...(duplicates && { duplicates }), description }
}

function foldDuplicationGroup(group) {
  const [first, ...rest] = group
  if (rest.length === 0) return first
  return {
    ...first,
    severity: rest.reduce((severity, finding) => higherSeverity(severity, finding.severity), first.severity),
    reviewers: [...new Set(group.flatMap(finding => finding.reviewers))],
    duplicates: group.find(finding => finding.duplicates)?.duplicates,
    locations: group.map(toLocation),
  }
}

// Folds each connected group of duplication findings into its earliest one. Unlike the
// same-line merge, one reviewer's findings fold together too: it flags each copy separately.
function mergeDuplication(findings) {
  const groups = []
  const groupByKey = new Map()
  for (const finding of findings) {
    if (normalizeCategory(finding.category) !== DUPLICATION_CATEGORY) {
      groups.push([finding])
      continue
    }
    const linkedGroups = [...new Set(duplicationKeys(finding).map(key => groupByKey.get(key)).filter(Boolean))]
    const group = [...linkedGroups.flat(), finding].sort((first, second) => findings.indexOf(first) - findings.indexOf(second))
    for (const linkedGroup of linkedGroups) groups.splice(groups.indexOf(linkedGroup), 1)
    groups.push(group)
    for (const member of group) for (const key of duplicationKeys(member)) groupByKey.set(key, group)
  }
  return groups
    .sort((first, second) => findings.indexOf(first[0]) - findings.indexOf(second[0]))
    .map(foldDuplicationGroup)
    .map((finding, index) => ({ ...finding, id: `F${index + 1}` }))
}

// Shorter than this, the start of an error message is too generic to tie two findings together.
const MIN_MESSAGE_KEY_LENGTH = 12

// The fixed start of an error message, before its first format placeholder (%, {, $).
function messageKey(message) {
  const key = message.split(/[%{$]/)[0].trim().toLowerCase()
  return key.length >= MIN_MESSAGE_KEY_LENGTH ? key : null
}

// The untested-failure-path precheck cites the line that raises an error; a reviewer cites the
// test file that lacks the test. Same fix, so a missing-test finding that quotes the error folds
// into the precheck's, and both places stay listed in its locations.
function foldIntoUntestedErrors(findings) {
  const untestedErrors = findings.filter(finding => finding.check === 'untested-failure-path' && finding.message && messageKey(finding.message))
  const folded = new Set()
  for (const untested of untestedErrors) {
    const key = messageKey(untested.message)
    for (const finding of findings) {
      const isMissingTestForIt =
        finding !== untested &&
        !folded.has(finding) &&
        normalizeCategory(finding.category) === normalizeCategory(untested.category) &&
        finding.description.toLowerCase().includes(key)
      if (!isMissingTestForIt) continue
      untested.severity = higherSeverity(untested.severity, finding.severity)
      untested.reviewers = [...new Set([...untested.reviewers, ...finding.reviewers])]
      untested.locations = [...(untested.locations ?? [toLocation(untested)]), toLocation(finding)]
      folded.add(finding)
    }
  }
  return findings.filter(finding => !folded.has(finding))
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
  return { findings: mergeDuplication(foldIntoUntestedErrors(findings)), dropped }
}

export function readDiffLines(diffPath) {
  const patchText = readTextFile(diffPath)
  // Every path below is matched against the b/ side; a patch without prefixes would silently
  // drop every finding as "not a file this diff changes".
  if (/^\+\+\+ (?!b\/|\/dev\/null)/m.test(patchText)) {
    fail(`${diffPath} has file headers without the b/ prefix; regenerate it with --src-prefix=a/ --dst-prefix=b/`)
  }
  return parseDiffLines(patchText)
}

if (isRunDirectly(import.meta.url)) {
  const usage = 'usage: merge-findings.mjs --diff <diff.patch> <findings.json>...'
  const [flag, diffPath, ...findingsPaths] = process.argv.slice(2)
  if (flag !== '--diff' || !diffPath) fail(`${usage} (--diff is required: findings are checked against it)`)
  if (findingsPaths.length === 0) fail(`${usage} (no findings files given)`)
  const diffLines = readDiffLines(diffPath)
  const { findings, dropped } = mergeFindings(findingsPaths.map(readJsonArrayFile), diffLines)
  reportDropped('findings', dropped)
  console.log(JSON.stringify(findings, null, 2))
}
