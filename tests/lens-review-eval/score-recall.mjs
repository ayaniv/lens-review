// Scores a review's kept findings against a real PR's answer key (gold.json): recall (gold
// issues caught / gold total), precision (findings that match a gold issue / findings kept),
// duplicates (kept findings beyond the first on one gold issue) and must-level recall.
//
// A finding matches a gold issue the way score-review.mjs matches a seed: file, line range and
// category, at the issue's own spot or one of its `alternates`, or at any copy a merged finding
// lists in `locations`. Findings are paired to issues one to one, as many pairs as possible, so a
// finding that fits two issues catches only one, and a second finding on an issue is a duplicate.
//
//   node score-recall.mjs --gold <gold.json> <findings.json>...
//     → {<findings file name>: score} on stdout
import path from 'node:path'
import { fail, isRunDirectly, readJsonArrayFile, readJsonFile } from '../../skills/lens-review/scripts/lib/cli.mjs'
import { matchesSeed } from './score-review.mjs'

function goldIssues(gold) {
  if (!Array.isArray(gold?.issues)) throw new Error('gold must hold an issues array')
  for (const issue of gold.issues) {
    if (!issue?.id || !Array.isArray(issue.line_range)) throw new Error(`gold issue ${JSON.stringify(issue)} needs an id and a line_range`)
  }
  return gold.issues
}

function findingSpots(finding) {
  return [finding, ...(finding.locations ?? []).map(({ file, line }) => ({ ...finding, file, line }))]
}

// Width of the narrowest spot of `issue` this finding matches, or null when none does.
function matchWidth(finding, issue) {
  const widths = [issue, ...(issue.alternates ?? [])]
    .filter(issueSpot => findingSpots(finding).some(spot => matchesSeed(spot, issueSpot)))
    .map(({ line_range: [first, last] }) => last - first)
  return widths.length > 0 ? Math.min(...widths) : null
}

// The issues a finding matches, the most specific first: a finding on a test's own lines is
// that test's issue before it is a broad "no test for X" anywhere in the file.
function matchingIssues(finding, issues) {
  return issues
    .map(issue => ({ issue, width: matchWidth(finding, issue) }))
    .filter(({ width }) => width !== null)
    .sort((first, second) => first.width - second.width)
    .map(({ issue }) => issue)
}

// Maximum one-to-one pairing of findings to issues (augmenting paths), as Map issue id → finding id.
function pairFindings(findings, issues) {
  const candidates = new Map(findings.map(finding => [finding.id, matchingIssues(finding, issues)]))
  const findingByIssue = new Map()
  function tryPair(finding, visited) {
    for (const issue of candidates.get(finding.id)) {
      if (visited.has(issue.id)) continue
      visited.add(issue.id)
      const holder = findingByIssue.get(issue.id)
      if (!holder || tryPair(holder, visited)) {
        findingByIssue.set(issue.id, finding)
        return true
      }
    }
    return false
  }
  for (const finding of findings) tryPair(finding, new Set())
  return { findingByIssue, candidates }
}

export function scoreRecall(gold, findings) {
  const issues = goldIssues(gold)
  const { findingByIssue, candidates } = pairFindings(findings, issues)
  const matched = findings.filter(finding => candidates.get(finding.id).length > 0)
  const mustIssues = issues.filter(issue => issue.severity === 'must')
  return {
    recall: { caught: findingByIssue.size, total: issues.length },
    precision: { matched: matched.length, kept: findings.length },
    duplicates: matched.length - findingByIssue.size,
    mustRecall: { caught: mustIssues.filter(issue => findingByIssue.has(issue.id)).length, total: mustIssues.length },
    caught: Object.fromEntries([...findingByIssue].map(([issueId, finding]) => [issueId, finding.id])),
    missed: issues.filter(issue => !findingByIssue.has(issue.id)).map(issue => issue.id),
    unmatched: findings.filter(finding => candidates.get(finding.id).length === 0).map(finding => finding.id),
  }
}

if (isRunDirectly(import.meta.url)) {
  const [flag, goldPath, ...findingsPaths] = process.argv.slice(2)
  if (flag !== '--gold' || !goldPath || findingsPaths.length === 0) fail('usage: score-recall.mjs --gold <gold.json> <findings.json>...')
  const gold = readJsonFile(goldPath)
  const scores = {}
  for (const findingsPath of findingsPaths) {
    try {
      scores[path.basename(findingsPath, '.json')] = scoreRecall(gold, readJsonArrayFile(findingsPath))
    } catch (error) {
      fail(`${goldPath}: ${error.message}`)
    }
  }
  console.log(JSON.stringify(scores, null, 2))
}
