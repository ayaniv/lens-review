// The skeptic's deterministic tail in one call: parse its reply into skeptic.json, check it
// ruled on every finding id in tallied.json, and build final-findings.json from the ones it
// kept. A finding the skeptic never ruled on would otherwise vanish from the report without a
// trace, so any gap fails the run instead of producing a partial review.
//
//   node apply-skeptic.mjs <run-dir>
//     reads <run-dir>/reply-skeptic.txt and tallied.json, writes skeptic.json and
//     final-findings.json → {kept, dropped} on stdout
import path from 'node:path'
import { fail, isRunDirectly, readJsonArrayFile } from './lib/cli.mjs'
import { parseReply, writeJson } from './parse-reply.mjs'

const VERDICTS = ['keep', 'drop']

// Throws naming every id the rulings leave out or rule on with an unknown verdict.
export function applySkeptic(findings, rulings) {
  if (!Array.isArray(rulings)) throw new Error('the skeptic reply is not a JSON array of rulings')
  const rulingById = new Map(rulings.filter(ruling => VERDICTS.includes(ruling?.verdict)).map(ruling => [ruling.id, ruling]))
  const unruled = findings.filter(finding => !rulingById.has(finding.id)).map(finding => finding.id)
  if (unruled.length > 0) throw new Error(`the skeptic gave no keep/drop verdict for ${unruled.join(', ')}`)
  return findings
    .filter(finding => rulingById.get(finding.id).verdict === 'keep')
    .map(finding => {
      const { verdict, reason } = rulingById.get(finding.id)
      return { ...finding, skeptic: { verdict, reason: reason ?? '' } }
    })
}

if (isRunDirectly(import.meta.url)) {
  const [runDir] = process.argv.slice(2)
  if (!runDir) fail('usage: apply-skeptic.mjs <run-dir>')
  const findings = readJsonArrayFile(path.join(runDir, 'tallied.json'))
  try {
    // With nothing to rule on, no skeptic runs and the review simply has no findings.
    const rulings = findings.length === 0 ? [] : parseReply(path.join(runDir, 'reply-skeptic.txt'))
    writeJson(path.join(runDir, 'skeptic.json'), rulings)
    const kept = applySkeptic(findings, rulings)
    writeJson(path.join(runDir, 'final-findings.json'), kept)
    console.log(JSON.stringify({ kept: kept.length, dropped: findings.length - kept.length }))
  } catch (error) {
    fail(error.message)
  }
}
