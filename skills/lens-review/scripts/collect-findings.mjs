// The reviewer phase's whole deterministic tail in one call: parse each reviewer's reply into
// findings-<stem>.json (crediting a finding with no reviewer to the agent that wrote it), then
// merge every one that parsed into merged.json. A reviewer whose reply is missing or isn't a
// findings array is a failed reviewer, listed in the summary; the rest still merge.
//
//   node collect-findings.mjs <run-dir> <stem>=<reviewer name>...
//     reads <run-dir>/reply-<stem>.txt and <run-dir>/diff.patch, writes findings-<stem>.json
//     and merged.json → {failedReviewers, droppedFindings, findings} on stdout
import path from 'node:path'
import { fail, isRunDirectly, reportDropped } from './lib/cli.mjs'
import { mergeFindings, readDiffLines } from './merge-findings.mjs'
import { parseReply, writeJson } from './parse-reply.mjs'

export function parseAgentArg(arg) {
  const separatorIndex = arg.indexOf('=')
  const stem = arg.slice(0, separatorIndex)
  const reviewer = arg.slice(separatorIndex + 1)
  if (separatorIndex < 1 || !reviewer) throw new Error(`"${arg}" is not <stem>=<reviewer name>`)
  return { stem, reviewer }
}

export function collectFindings(runDir, agents) {
  const findingsPerReviewer = []
  const failedReviewers = []
  for (const { stem, reviewer } of agents) {
    try {
      const findings = parseReply(path.join(runDir, `reply-${stem}.txt`), { defaultReviewer: reviewer })
      writeJson(path.join(runDir, `findings-${stem}.json`), findings)
      findingsPerReviewer.push(findings)
    } catch (error) {
      failedReviewers.push({ reviewer, reason: error.message })
    }
  }
  const { findings, dropped } = mergeFindings(findingsPerReviewer, readDiffLines(path.join(runDir, 'diff.patch')))
  writeJson(path.join(runDir, 'merged.json'), findings)
  return { findings, dropped, failedReviewers }
}

if (isRunDirectly(import.meta.url)) {
  const [runDir, ...agentArgs] = process.argv.slice(2)
  if (!runDir || agentArgs.length === 0) fail('usage: collect-findings.mjs <run-dir> <stem>=<reviewer name>...')
  let agents
  try {
    agents = agentArgs.map(parseAgentArg)
  } catch (error) {
    fail(error.message)
  }
  const { findings, dropped, failedReviewers } = collectFindings(runDir, agents)
  for (const { reason } of failedReviewers) console.error(`lens-review: failed reviewer: ${reason}`)
  reportDropped('findings', dropped)
  const summary = {
    failedReviewers: failedReviewers.map(({ reviewer }) => reviewer),
    droppedFindings: dropped.length,
    findings: findings.length,
  }
  console.log(JSON.stringify(summary))
}
