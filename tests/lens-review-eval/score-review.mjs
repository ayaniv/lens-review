// Scores a review's final findings against the seeded PR's expected.json: every must_catch
// has to be caught, and no surviving finding may make a must_drop's false claim. Both match
// on location plus every optional field the seed names, so a must_drop with a category leaves
// other, legitimate findings at the same spot alone.
//
//   node score-review.mjs --expected <expected.json> --actual <final-findings.json>
//     → score JSON on stdout; exit 0 when it passed, 1 when it did not
import { fail, isRunDirectly, readJsonArrayFile, readJsonFile } from '../../skills/lens-review/scripts/lib/cli.mjs'
import { normalizeCategory } from '../../skills/lens-review/scripts/merge-findings.mjs'

function isInRange(finding, seeded) {
  const [firstLine, lastLine] = seeded.line_range
  return finding.file === seeded.file && finding.line >= firstLine && finding.line <= lastLine
}

export function matchesSeed(finding, seeded) {
  if (!isInRange(finding, seeded)) return false
  if (seeded.category && normalizeCategory(finding.category ?? '') !== normalizeCategory(seeded.category)) return false
  if (seeded.reviewer && !(finding.reviewers ?? []).some(reviewer => reviewer.includes(seeded.reviewer))) return false
  if (seeded.duplicates && finding.duplicates?.split(':')[0] !== seeded.duplicates.split(':')[0]) return false
  return true
}

export function scoreReview(expected, findings) {
  const missed = expected.must_catch.filter(seeded => !findings.some(finding => matchesSeed(finding, seeded)))
  const falsePositives = findings.filter(finding => expected.must_drop.some(seeded => matchesSeed(finding, seeded)))
  return { passed: missed.length === 0 && falsePositives.length === 0, missed, falsePositives }
}

function flagValue(flag) {
  const flagIndex = process.argv.indexOf(flag)
  return flagIndex === -1 ? null : process.argv[flagIndex + 1]
}

if (isRunDirectly(import.meta.url)) {
  const expectedPath = flagValue('--expected')
  const actualPath = flagValue('--actual')
  if (!expectedPath || !actualPath) fail('usage: score-review.mjs --expected <expected.json> --actual <final-findings.json>')
  const score = scoreReview(readJsonFile(expectedPath), readJsonArrayFile(actualPath))
  console.log(JSON.stringify(score, null, 2))
  process.exitCode = score.passed ? 0 : 1
}
