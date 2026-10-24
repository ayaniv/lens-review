// Turns one agent's raw reply into the JSON file the next step reads. Agents are told to
// return bare JSON, but some still wrap it in a code fence; stripping that here, the same way
// every run, keeps "is this reviewer failed?" from depending on the orchestrator's judgement.
// Anything else that isn't JSON fails, and the caller counts that agent as failed.
//
// With --default-reviewer the reply must be a findings array, and a finding that leaves out
// `reviewer` is credited to the agent the caller names: the caller knows who wrote the reply,
// so a missing field is no reason to lose a finding. merge-findings.mjs still drops the ones
// that are actually malformed.
//
//   node parse-reply.mjs <reply.txt> <out.json> [--default-reviewer <name>]
//     → writes out.json; non-zero exit when not JSON (with the flag: not a JSON array)
import fs from 'node:fs'
import { fail, isRunDirectly } from './lib/cli.mjs'

const WHOLE_REPLY_FENCE = /^```[\w-]*\n([\s\S]*?)\n```$/

export function unfence(replyText) {
  const trimmed = replyText.trim()
  return trimmed.match(WHOLE_REPLY_FENCE)?.[1] ?? trimmed
}

function hasReviewer(finding) {
  return typeof finding.reviewer === 'string' && finding.reviewer.length > 0
}

export function withDefaultReviewer(findings, reviewer) {
  return findings.map(finding =>
    finding && typeof finding === 'object' && !hasReviewer(finding) ? { ...finding, reviewer } : finding,
  )
}

// Throws a message naming the reply when it is missing or can't be used.
export function parseReply(replyPath, { defaultReviewer = null } = {}) {
  let parsed
  try {
    parsed = JSON.parse(unfence(fs.readFileSync(replyPath, 'utf8')))
  } catch (error) {
    throw new Error(`${replyPath} is not a JSON reply (a single surrounding code fence is the only wrapper allowed): ${error.message}`)
  }
  if (defaultReviewer === null) return parsed
  if (!Array.isArray(parsed)) throw new Error(`${replyPath} is not a JSON array of findings`)
  return withDefaultReviewer(parsed, defaultReviewer)
}

export function writeJson(outPath, value) {
  fs.writeFileSync(outPath, `${JSON.stringify(value, null, 2)}\n`)
}

if (isRunDirectly(import.meta.url)) {
  const usage = 'usage: parse-reply.mjs <reply.txt> <out.json> [--default-reviewer <name>]'
  const [replyPath, outPath, ...flags] = process.argv.slice(2)
  if (!replyPath || !outPath) fail(usage)
  const flagIndex = flags.indexOf('--default-reviewer')
  const defaultReviewer = flagIndex === -1 ? null : flags[flagIndex + 1]
  if (flagIndex !== -1 && !defaultReviewer) fail(`${usage} (--default-reviewer needs a name)`)
  try {
    writeJson(outPath, parseReply(replyPath, { defaultReviewer }))
  } catch (error) {
    fail(error.message)
  }
}
