// Builds the GitHub review that Step 6 offers to post: one COMMENT review on the PR's head commit,
// the summary as its body, and each final finding as an inline comment on its line. A
// finding GitHub can't anchor (its line isn't in the PR's diff) goes into the body instead,
// so nothing the skeptic kept is lost.
//
//   node build-pr-review.mjs --findings <final-findings.json> --diff <diff.patch> \
//     --summary <summary.md> --commit <head sha>   → review payload JSON on stdout
import { fail, isRunDirectly, readJsonArrayFile, readTextFile } from './lib/cli.mjs'
import { isLineInDiff, parseDiffLines, SEVERITIES } from './merge-findings.mjs'

// Hidden in the review body so a later run can tell lens-review already reviewed this PR.
export const REVIEW_MARKER = '<!-- lens-review -->'

const SEVERITY_LABELS = { must: 'Must fix', should: 'Should fix', suggestion: 'Suggestion' }
const FULL_SHA_RE = /^[0-9a-f]{40}$/

function unrenderableReason(finding) {
  if (typeof finding?.file !== 'string' || !finding.file) return 'missing file'
  if (!Number.isInteger(finding.line) || finding.line < 1) return 'missing or invalid line'
  if (!SEVERITIES.includes(finding.severity)) return `unknown severity "${finding.severity}"`
  if (typeof finding.description !== 'string' || !finding.description) return 'missing description'
  return null
}

function duplicatesNote(finding) {
  return finding.duplicates ? ` Duplicates \`${finding.duplicates}\`.` : ''
}

// A merged duplication finding is posted once, so its comment names every copy it stands for.
function locationsNote(finding, { separator, indent }) {
  if (!finding.locations) return ''
  const copies = finding.locations.map(({ file, line, duplicates }) =>
    `${indent}- \`${file}:${line}\`${duplicates ? ` (duplicates \`${duplicates}\`)` : ''}`,
  )
  return `${separator}${indent}Every copy:\n${copies.join('\n')}`
}

// Reviewer names stay in final-findings.json: on the PR they read as noise to its author.
function inlineCommentBody(finding) {
  const heading = `**${SEVERITY_LABELS[finding.severity]}** · ${finding.category}`
  const copies = locationsNote(finding, { separator: '\n\n', indent: '' })
  const rule = finding.rule ? `\n\n<sub>Rule: ${finding.rule}</sub>` : ''
  return `${heading}\n\n${finding.description}${duplicatesNote(finding)}${copies}${rule}`
}

function bodyOnlyLine(finding) {
  const location = `\`${finding.file}:${finding.line}\``
  return `- **${SEVERITY_LABELS[finding.severity]}** [${finding.category}] ${finding.description} — ${location}${duplicatesNote(finding)}${locationsNote(finding, { separator: '\n', indent: '  ' })}`
}

export function buildPrReview({ findings, diffLines, summary, commitId }) {
  for (const finding of findings) {
    const reason = unrenderableReason(finding)
    if (reason) throw new Error(`finding ${finding?.id ?? JSON.stringify(finding)}: ${reason}`)
  }
  const inline = findings.filter(finding => isLineInDiff(diffLines, finding.file, finding.line))
  const bodyOnly = findings.filter(finding => !inline.includes(finding))
  const bodyOnlySection =
    bodyOnly.length > 0 ? `\n\n### Not on a changed line (${bodyOnly.length})\n${bodyOnly.map(bodyOnlyLine).join('\n')}` : ''
  return {
    commit_id: commitId,
    event: 'COMMENT',
    body: `${summary.trim()}${bodyOnlySection}\n\n${REVIEW_MARKER}`,
    comments: inline.map(finding => ({
      path: finding.file,
      line: finding.line,
      side: 'RIGHT',
      body: inlineCommentBody(finding),
    })),
  }
}

function flagValue(args, flag) {
  const flagIndex = args.indexOf(flag)
  return flagIndex === -1 ? null : args[flagIndex + 1]
}

if (isRunDirectly(import.meta.url)) {
  const usage = 'usage: build-pr-review.mjs --findings <final-findings.json> --diff <diff.patch> --summary <summary.md> --commit <head sha>'
  const args = process.argv.slice(2)
  const [findingsPath, diffPath, summaryPath, commitId] = ['--findings', '--diff', '--summary', '--commit'].map(flag =>
    flagValue(args, flag),
  )
  if (!findingsPath || !diffPath || !summaryPath || !commitId) fail(usage)
  if (!FULL_SHA_RE.test(commitId)) fail(`--commit must be the PR head's full 40-character SHA, got "${commitId}"`)
  try {
    const findings = readJsonArrayFile(findingsPath)
    const review = buildPrReview({
      findings,
      diffLines: parseDiffLines(readTextFile(diffPath)),
      summary: readTextFile(summaryPath),
      commitId,
    })
    const bodyOnlyCount = findings.length - review.comments.length
    console.error(`lens-review: ${review.comments.length} inline, ${bodyOnlyCount} in the review body`)
    console.log(JSON.stringify(review, null, 2))
  } catch (error) {
    fail(error.message)
  }
}
