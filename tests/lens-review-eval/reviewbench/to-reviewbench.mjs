// Turns lens-review's final-findings.json into the findings file ReviewBench's agent contract
// asks for (AGENT_CONTRACT.md): {pr, agent, findings: [{file, start_line, end_line, message,
// producer}], usage?}. ReviewBench's judge matches findings semantically, so one kept finding is
// one ReviewBench finding at its line, and a merged finding stays one logical issue.
const FULL_SHA_RE = /^[0-9a-f]{40}$/

function repoRelative(file) {
  return file.replace(/^\.\//, '')
}

// The judge sees only the message, so a merged finding names the copies its own line doesn't.
function otherCopiesNote(finding) {
  const primary = `${repoRelative(finding.file)}:${finding.line}`
  const others = (finding.locations ?? [])
    .map(({ file, line }) => `${repoRelative(file)}:${line}`)
    .filter(location => location !== primary)
  return others.length > 0 ? ` Also at ${others.join(', ')}.` : ''
}

function unconvertibleReason(finding) {
  if (typeof finding?.file !== 'string' || !finding.file) return 'missing file'
  if (!Number.isInteger(finding.line) || finding.line < 1) return 'missing or invalid line'
  if (typeof finding.description !== 'string' || !finding.description) return 'missing description'
  return null
}

export function toReviewBenchFindings(finalFindings, pr, agent, usage) {
  for (const field of ['base', 'head']) {
    if (!FULL_SHA_RE.test(pr?.[field] ?? '')) throw new Error(`pr ${field} must be a 40-character SHA, got "${pr?.[field]}"`)
  }
  const findings = finalFindings.map(finding => {
    const reason = unconvertibleReason(finding)
    if (reason) throw new Error(`finding ${finding?.id ?? JSON.stringify(finding)}: ${reason}`)
    return {
      file: repoRelative(finding.file),
      start_line: finding.line,
      end_line: finding.line,
      message: `${finding.description}${otherCopiesNote(finding)}`,
      producer: agent,
    }
  })
  return { pr, agent, findings, ...(usage ? { usage } : {}) }
}
