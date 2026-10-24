// The challenge round's deterministic tail in one call: parse each persona's ballot into
// votes-<stem>.json, then tally every ballot that parsed against merged.json into
// tallied.json. A persona whose reply is missing or isn't JSON is a failed voter.
//
//   node collect-votes.mjs <run-dir> [<persona-file-stem>...]
//     reads <run-dir>/reply-votes-<stem>.txt and merged.json, writes votes-<stem>.json and
//     tallied.json → {voted, failedVoters, contested, droppedVotes} on stdout
import path from 'node:path'
import { fail, isRunDirectly, readJsonArrayFile, reportDropped } from './lib/cli.mjs'
import { parseReply, writeJson } from './parse-reply.mjs'
import { tallyChallenges } from './tally-challenges.mjs'

export function collectVotes(runDir, stems) {
  const ballots = []
  const failedVoters = []
  for (const stem of stems) {
    try {
      const ballot = parseReply(path.join(runDir, `reply-votes-${stem}.txt`))
      writeJson(path.join(runDir, `votes-${stem}.json`), ballot)
      ballots.push(ballot)
    } catch (error) {
      failedVoters.push({ stem, reason: error.message })
    }
  }
  const { findings, dropped } = tallyChallenges(readJsonArrayFile(path.join(runDir, 'merged.json')), ballots)
  writeJson(path.join(runDir, 'tallied.json'), findings)
  return { findings, dropped, voted: ballots.length, failedVoters }
}

if (isRunDirectly(import.meta.url)) {
  const [runDir, ...stems] = process.argv.slice(2)
  // No stems is a skipped round (no findings to vote on): tallied.json is still written.
  if (!runDir) fail('usage: collect-votes.mjs <run-dir> [<persona-file-stem>...]')
  const { findings, dropped, voted, failedVoters } = collectVotes(runDir, stems)
  for (const { reason } of failedVoters) console.error(`lens-review: failed voter: ${reason}`)
  reportDropped('votes', dropped)
  const summary = {
    voted,
    failedVoters: failedVoters.map(({ stem }) => stem),
    contested: findings.filter(finding => finding.contested).length,
    droppedVotes: dropped.length,
  }
  console.log(JSON.stringify(summary))
}
