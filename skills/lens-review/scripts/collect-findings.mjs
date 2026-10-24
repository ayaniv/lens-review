// The reviewer phase's whole deterministic tail in one call: parse each reviewer's reply into
// findings-<stem>.json (crediting a finding with no reviewer to the agent that wrote it), then
// merge every one that parsed into merged.json, with precheck.mjs's findings when the run has
// them. A reviewer whose reply is missing or isn't a findings array is a failed reviewer,
// listed in the summary; the rest still merge.
//
//   node collect-findings.mjs <run-dir> <stem>=<reviewer name>...
//     reads <run-dir>/reply-<stem>.txt, precheck.json (if any) and diff.patch, writes
//     findings-<stem>.json and merged.json → {failedReviewers, droppedFindings, prechecks, findings} on stdout
import fs from 'node:fs'
import path from 'node:path'
import { fail, isRunDirectly, reportDropped } from './lib/cli.mjs'
import { mergeFindings, readDiffLines } from './merge-findings.mjs'
import { parseReply, writeJson } from './parse-reply.mjs'
import { PRECHECK_REVIEWER } from './prechecks/finding.mjs'

export function parseAgentArg(arg) {
  const separatorIndex = arg.indexOf('=')
  const stem = arg.slice(0, separatorIndex)
  const reviewer = arg.slice(separatorIndex + 1)
  if (separatorIndex < 1 || !reviewer) throw new Error(`"${arg}" is not <stem>=<reviewer name>`)
  return { stem, reviewer }
}

// Every source of findings: each reviewer's reply, saved as findings-<stem>.json once parsed,
// and the run's precheck.json when precheck.mjs wrote one.
function findingSources(runDir, agents) {
  const replies = agents.map(({ stem, reviewer }) => ({
    reviewer,
    inPath: path.join(runDir, `reply-${stem}.txt`),
    outPath: path.join(runDir, `findings-${stem}.json`),
  }))
  const precheckPath = path.join(runDir, 'precheck.json')
  return fs.existsSync(precheckPath) ? [...replies, { reviewer: PRECHECK_REVIEWER, inPath: precheckPath, outPath: null }] : replies
}

export function collectFindings(runDir, agents) {
  const findingsPerReviewer = []
  const failedReviewers = []
  let prechecks = 0
  for (const { reviewer, inPath, outPath } of findingSources(runDir, agents)) {
    try {
      const findings = parseReply(inPath, { defaultReviewer: reviewer })
      if (outPath) writeJson(outPath, findings)
      if (reviewer === PRECHECK_REVIEWER) prechecks = findings.length
      findingsPerReviewer.push(findings)
    } catch (error) {
      failedReviewers.push({ reviewer, reason: error.message })
    }
  }
  const { findings, dropped } = mergeFindings(findingsPerReviewer, readDiffLines(path.join(runDir, 'diff.patch')))
  writeJson(path.join(runDir, 'merged.json'), findings)
  return { findings, dropped, failedReviewers, prechecks }
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
  const { findings, dropped, failedReviewers, prechecks } = collectFindings(runDir, agents)
  for (const { reason } of failedReviewers) console.error(`lens-review: failed reviewer: ${reason}`)
  reportDropped('findings', dropped)
  const summary = {
    failedReviewers: failedReviewers.map(({ reviewer }) => reviewer),
    droppedFindings: dropped.length,
    prechecks,
    findings: findings.length,
  }
  console.log(JSON.stringify(summary))
}
