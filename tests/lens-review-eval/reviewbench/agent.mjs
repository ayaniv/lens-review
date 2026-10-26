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
//   RB_PR_JSON                 optional, set by ReviewBench: the PR's {title, body, …}, passed
//                              to lens-review as --context
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
    prJsonPath: env.RB_PR_JSON || null,
  }
}

// The PR's title and body, the way PR URL mode's pr-context.txt holds them; a PR with no body
// gives its title alone.
function readPrDescription(prJsonPath) {
  const text = readTextFile(prJsonPath)
  let pr
  try {
    pr = JSON.parse(text)
  } catch (error) {
    fail(`RB_PR_JSON ${prJsonPath} is not JSON: ${error.message}`)
  }
  if (typeof pr?.title !== 'string' || !pr.title.trim()) fail(`RB_PR_JSON ${prJsonPath} has no title`)
  const body = typeof pr.body === 'string' ? pr.body.trim() : ''
  return body ? `${pr.title}\n\n${body}\n` : `${pr.title}\n`
}

function assertCheckoutAtHead({ repoDir, head }) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' })
  if (result.error || result.status !== 0) fail(`cannot read HEAD of ${repoDir}: ${result.error?.message ?? result.stderr.trim()}`)
  const checkedOut = result.stdout.trim()
  if (checkedOut !== head) fail(`${repoDir} is checked out at ${checkedOut}, not RB_HEAD ${head}`)
}

function claudeArgs({ base, model, maxBudgetUsd }, contextPath) {
  return [
    '-p', `/lens-review --base ${base}${contextPath ? ` --context ${contextPath}` : ''}`,
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-budget-usd', maxBudgetUsd,
    // The container is the sandbox and the checkout is discarded after the run, the same reason
    // ReviewBench's Codex example bypasses its sandbox. An allowlist that missed one of the tools
    // lens-review needs would fail a PR halfway through a paid run; the deny list still applies.
    '--dangerously-skip-permissions',
    // Variadic, so it goes last: anything after it would be read as one more tool name. The git
    // rules close try-agent.sh's `upstream` remote, whose later commits can hold the fixes being
    // scored; local --base mode never fetches, so lens-review itself doesn't need them.
    '--disallowedTools', 'WebFetch', 'WebSearch', 'Bash(gh:*)', 'Bash(curl:*)', 'Bash(wget:*)',
    'Bash(git fetch:*)', 'Bash(git pull:*)', 'Bash(git remote:*)',
  ]
}

// Writes claude's stream-json straight to the log rather than buffering it: a large PR's stream
// can outgrow spawnSync's output buffer, and the log is what's read by hand after a pilot.
function runLensReview(settings, contextPath, logPath) {
  const lensReviewHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-review-home-'))
  const logFd = fs.openSync(logPath, 'w')
  try {
    const result = spawnSync(settings.claudeBin, claudeArgs(settings, contextPath), {
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

function readStreamEvents(logPath) {
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
  return events
}

function successfulResultEvent(events, logPath) {
  const resultEvent = events.findLast(event => event.type === 'result')
  if (!resultEvent) fail(`claude's stream has no result event; see ${logPath}`)
  if (resultEvent.subtype !== 'success') fail(`the review ended with ${resultEvent.subtype}, not success; see ${logPath}`)
  return resultEvent
}

// The result event holds only claude's last message, and Step 6 always speaks after the report
// (in the container its `gh pr view` is denied, so the run ends "Not offered for posting"). So
// the report is searched for in every assistant text block too, and the last line found wins.
function streamTexts(events) {
  return events.flatMap(event => {
    if (event.type === 'result') return [String(event.result ?? '')]
    if (event.type !== 'assistant') return []
    const content = event.message?.content
    return Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => String(block.text ?? '')) : []
  })
}

function readFinalFindings(events, { repoDir }, logPath) {
  const findingsPath = streamTexts(events)
    .flatMap(text => [...text.matchAll(/^Findings JSON: (.+)$/gm)].map(match => match[1]))
    .at(-1)
  if (!findingsPath) fail(`lens-review's report has no "Findings JSON:" line; see ${logPath}`)
  return readJsonArrayFile(path.resolve(repoDir, findingsPath.trim()))
}

function main() {
  const settings = readSettings(process.env)
  assertCheckoutAtHead(settings)
  const prDescription = settings.prJsonPath ? readPrDescription(settings.prJsonPath) : null
  // The contract asks every agent to print the configuration it applied.
  console.log(`lens-review-reviewbench: model=${settings.model} max_budget_usd=${settings.maxBudgetUsd}`)
  fs.mkdirSync(path.dirname(settings.outPath), { recursive: true })
  const logPath = path.join(path.dirname(settings.outPath), 'lens-review.log')
  const contextPath = prDescription ? path.join(path.dirname(settings.outPath), 'pr-context.md') : null
  if (contextPath) fs.writeFileSync(contextPath, prDescription)
  runLensReview(settings, contextPath, logPath)
  const events = readStreamEvents(logPath)
  const resultEvent = successfulResultEvent(events, logPath)
  const finalFindings = readFinalFindings(events, settings, logPath)
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
