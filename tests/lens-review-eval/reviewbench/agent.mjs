// The ReviewBench container's entrypoint (AGENT_CONTRACT.md): runs lens-review headless on the
// checkout ReviewBench mounted, then writes its kept findings to RB_OUT in the contract's
// format. Every failure exits non-zero without writing RB_OUT, so ReviewBench fails the PR
// instead of scoring a partial review.
//
//   RB_NWO, RB_PR_NUMBER, RB_BASE, RB_HEAD, RB_AGENT, RB_OUT   set by ReviewBench
//   RB_CONFIG_MAX_BUDGET_USD   required per-PR spend cap, passed to `claude --max-budget-usd`
//   RB_CONFIG_MODEL            optional, default claude-opus-5-5
//   CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY
//   RB_REPO                    the checkout, default /work/repo
//   CLAUDE_BIN                 tests only: a fake `claude`
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fail, isRunDirectly, readJsonArrayFile, readTextFile, reportDropped } from '../../../skills/lens-review/scripts/lib/cli.mjs'
import { toReviewBenchFindings } from './to-reviewbench.mjs'

const REQUIRED_VARS = ['RB_NWO', 'RB_PR_NUMBER', 'RB_BASE', 'RB_HEAD', 'RB_AGENT', 'RB_OUT']
const CREDENTIAL_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']
const DEFAULT_REPO = '/work/repo'
// lens-review's measured costs assume Opus.
const DEFAULT_MODEL = 'claude-opus-5-5'

function readSettings(env) {
  for (const name of REQUIRED_VARS) {
    if (!env[name]) fail(`${name} is not set; ReviewBench's runner sets it for every PR`)
  }
  if (!/^[1-9]\d*$/.test(env.RB_PR_NUMBER)) fail(`RB_PR_NUMBER must be a positive integer, got "${env.RB_PR_NUMBER}"`)
  if (!CREDENTIAL_VARS.some(name => env[name])) fail(`set ${CREDENTIAL_VARS.join(' or ')} to run the review`)
  const maxBudgetUsd = Number(env.RB_CONFIG_MAX_BUDGET_USD)
  if (!env.RB_CONFIG_MAX_BUDGET_USD || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    fail(`RB_CONFIG_MAX_BUDGET_USD must be a positive number of dollars, got "${env.RB_CONFIG_MAX_BUDGET_USD ?? ''}"`)
  }
  return {
    nwo: env.RB_NWO,
    prNumber: Number(env.RB_PR_NUMBER),
    base: env.RB_BASE,
    head: env.RB_HEAD,
    agent: env.RB_AGENT,
    outPath: env.RB_OUT,
    repoDir: env.RB_REPO || DEFAULT_REPO,
    model: env.RB_CONFIG_MODEL || DEFAULT_MODEL,
    maxBudgetUsd: env.RB_CONFIG_MAX_BUDGET_USD,
    claudeBin: env.CLAUDE_BIN || 'claude',
  }
}

function assertCheckoutAtHead({ repoDir, head }) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' })
  if (result.error || result.status !== 0) fail(`cannot read HEAD of ${repoDir}: ${result.error?.message ?? result.stderr.trim()}`)
  const checkedOut = result.stdout.trim()
  if (checkedOut !== head) fail(`${repoDir} is checked out at ${checkedOut}, not RB_HEAD ${head}`)
}

function claudeArgs({ base, model, maxBudgetUsd }) {
  return [
    '-p', `/lens-review --base ${base}`,
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-budget-usd', maxBudgetUsd,
    // The container is the sandbox and the checkout is discarded after the run, the same reason
    // ReviewBench's Codex example bypasses its sandbox. An allowlist that missed one of the tools
    // lens-review needs would fail a PR halfway through a paid run; the deny list still applies.
    '--dangerously-skip-permissions',
    // Variadic, so it goes last: anything after it would be read as one more tool name.
    '--disallowedTools', 'WebFetch', 'WebSearch', 'Bash(gh:*)', 'Bash(curl:*)', 'Bash(wget:*)',
  ]
}

// Writes claude's stream-json straight to the log rather than buffering it: a large PR's stream
// can outgrow spawnSync's output buffer, and the log is what's read by hand after a pilot.
function runLensReview(settings, logPath) {
  const lensReviewHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-review-home-'))
  const logFd = fs.openSync(logPath, 'w')
  try {
    const result = spawnSync(settings.claudeBin, claudeArgs(settings), {
      cwd: settings.repoDir,
      env: {
        ...process.env,
        LENS_REVIEW_HOME: lensReviewHome,
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      stdio: ['ignore', logFd, 'inherit'],
    })
    if (result.error) fail(`cannot start claude (${settings.claudeBin}): ${result.error.message}`)
    if (result.status !== 0) fail(`claude exited with ${result.signal ?? `status ${result.status}`}; see ${logPath}`)
  } finally {
    fs.closeSync(logFd)
  }
}

function readResultEvent(logPath) {
  const events = []
  const dropped = []
  for (const line of readTextFile(logPath).split('\n').filter(line => line.trim())) {
    try {
      events.push(JSON.parse(line))
    } catch (error) {
      dropped.push({ item: line, reason: error.message })
    }
  }
  reportDropped('stream lines', dropped)
  const resultEvent = events.findLast(event => event.type === 'result')
  if (!resultEvent) fail(`claude's stream has no result event; see ${logPath}`)
  if (resultEvent.subtype !== 'success') fail(`the review ended with ${resultEvent.subtype}, not success; see ${logPath}`)
  return resultEvent
}

function readFinalFindings(resultEvent, { repoDir }, logPath) {
  const findingsPath = String(resultEvent.result ?? '').match(/^Findings JSON: (.+)$/m)?.[1]
  if (!findingsPath) fail(`lens-review's report has no "Findings JSON:" line; see ${logPath}`)
  return readJsonArrayFile(path.resolve(repoDir, findingsPath.trim()))
}

function main() {
  const settings = readSettings(process.env)
  assertCheckoutAtHead(settings)
  // The contract asks every agent to print the configuration it applied.
  console.log(`lens-review-reviewbench: model=${settings.model} max_budget_usd=${settings.maxBudgetUsd}`)
  fs.mkdirSync(path.dirname(settings.outPath), { recursive: true })
  const logPath = path.join(path.dirname(settings.outPath), 'lens-review.log')
  runLensReview(settings, logPath)
  const resultEvent = readResultEvent(logPath)
  const finalFindings = readFinalFindings(resultEvent, settings, logPath)
  const pr = { repo: `https://github.com/${settings.nwo}`, pr_number: settings.prNumber, base: settings.base, head: settings.head }
  const usage = { cost_usd: resultEvent.total_cost_usd, time_in_ms: resultEvent.duration_ms }
  let output
  try {
    output = toReviewBenchFindings(finalFindings, pr, settings.agent, usage)
  } catch (error) {
    fail(`cannot convert lens-review's findings: ${error.message}`)
  }
  fs.writeFileSync(settings.outPath, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`lens-review-reviewbench: wrote ${output.findings.length} findings to ${settings.outPath}`)
}

if (isRunDirectly(import.meta.url)) main()
