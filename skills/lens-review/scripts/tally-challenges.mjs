// Attaches the team challenge round's votes to the merged findings and marks a finding
// `contested` when the team disputes it more than it agrees. A dispute is evidence for the
// skeptic, not a veto: contested findings stay in the list.
//
//   node tally-challenges.mjs <merged.json> <votes-*.json>...   → tallied JSON array on stdout
import { fail, isRunDirectly, readJsonArrayFile, readJsonFile, reportDropped } from './lib/cli.mjs'

const VERDICTS = ['agree', 'dispute']

function hasVoted(finding, persona) {
  return VERDICTS.some(verdict => finding.challenge[verdict].some(vote => vote.persona === persona))
}

function voteDropReason(vote, finding, persona) {
  if (!finding) return `unknown finding id "${vote?.id}"`
  if (!VERDICTS.includes(vote.verdict)) return `unknown verdict "${vote.verdict}"`
  if (finding.reviewers.includes(persona)) return 'self-vote on its own finding'
  // One persona repeating a verdict must not outvote the rest of the team.
  if (hasVoted(finding, persona)) return 'repeat vote on the same finding'
  return null
}

export function tallyChallenges(findings, ballots) {
  const tallied = findings.map(finding => ({ ...finding, challenge: { agree: [], dispute: [] }, contested: false }))
  const findingsById = new Map(tallied.map(finding => [finding.id, finding]))
  const dropped = []
  for (const ballot of ballots) {
    if (typeof ballot?.persona !== 'string' || !Array.isArray(ballot.votes)) {
      dropped.push({ item: ballot, reason: 'ballot needs a persona and a votes array' })
      continue
    }
    for (const vote of ballot.votes) {
      const finding = findingsById.get(vote?.id)
      const reason = voteDropReason(vote, finding, ballot.persona)
      if (reason) {
        dropped.push({ item: { persona: ballot.persona, ...vote }, reason })
        continue
      }
      finding.challenge[vote.verdict].push({ persona: ballot.persona, reason: vote.reason ?? '' })
    }
  }
  for (const finding of tallied) finding.contested = finding.challenge.dispute.length > finding.challenge.agree.length
  return { findings: tallied, dropped }
}

if (isRunDirectly(import.meta.url)) {
  const [findingsPath, ...votesPaths] = process.argv.slice(2)
  if (!findingsPath) fail('usage: tally-challenges.mjs <merged.json> <votes-*.json>...')
  const { findings, dropped } = tallyChallenges(readJsonArrayFile(findingsPath), votesPaths.map(readJsonFile))
  reportDropped('votes', dropped)
  console.log(JSON.stringify(findings, null, 2))
}
