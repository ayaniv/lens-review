import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, git, makeGitRepo, makeTempDir, readText, runScript, writeFiles } from './helpers.mjs'

// The ReviewBench adapter: a container entrypoint that satisfies ReviewBench's agent contract
// (AGENT_CONTRACT.md) by running lens-review headless and writing its findings in the judge's
// format. Every test here runs offline: `claude` is a local fake, so no test can start a live
// review, and nothing here builds or runs the image.
const BENCH_DIR = path.join(REPO_ROOT, 'tests', 'lens-review-eval', 'reviewbench')
const TO_REVIEWBENCH = path.join(BENCH_DIR, 'to-reviewbench.mjs')
const AGENT_ENTRYPOINT = path.join(BENCH_DIR, 'agent.mjs')
const DOCKERFILE = path.join(BENCH_DIR, 'Dockerfile')
const DOCKERIGNORE = path.join(BENCH_DIR, 'Dockerfile.dockerignore')

// try-agent.sh names every run's agent this way; the adapter must echo RB_AGENT back.
const AGENT = 'try-agent'
const NWO = 'acme/widgets'
const PR_NUMBER = 7
const BUDGET_USD = '4'

function lensFinding(id, overrides = {}) {
  return {
    id,
    file: 'src/a.ts',
    line: 2,
    severity: 'should',
    category: 'correctness',
    description: `${id}: the total ignores the discount.`,
    reviewer: 'Anthropic',
    skeptic: { verdict: 'keep', reason: 'real' },
    ...overrides,
  }
}

describe('reviewbench/to-reviewbench.mjs — lens-review findings in the judge\'s input format', () => {
  let toReviewBenchFindings
  let pr

  beforeEach(async () => {
    ;({ toReviewBenchFindings } = await import(TO_REVIEWBENCH))
    pr = { repo: `https://github.com/${NWO}`, pr_number: PR_NUMBER, base: 'a'.repeat(40), head: 'b'.repeat(40) }
  })

  test('maps each kept finding onto one ReviewBench finding at its line', () => {
    const output = toReviewBenchFindings([lensFinding('F1')], pr, AGENT)
    assert.deepEqual(output, {
      pr,
      agent: AGENT,
      findings: [{ file: 'src/a.ts', start_line: 2, end_line: 2, message: 'F1: the total ignores the discount.', producer: AGENT }],
    })
  })

  test('keeps a merged finding as one logical issue and names its other copies in the message', () => {
    const merged = lensFinding('F1', {
      locations: [
        { file: 'src/a.ts', line: 2, description: 'copy one' },
        { file: 'src/b.ts', line: 3, description: 'copy two' },
        { file: 'src/c.ts', line: 9, description: 'copy three' },
      ],
    })
    const [finding] = toReviewBenchFindings([merged], pr, AGENT).findings
    assert.equal(finding.file, 'src/a.ts')
    assert.match(finding.message, /^F1: the total ignores the discount\./)
    assert.match(finding.message, /src\/b\.ts:3/)
    assert.match(finding.message, /src\/c\.ts:9/)
    assert.doesNotMatch(finding.message, /src\/a\.ts:2/)
  })

  test('writes repo-relative paths without a leading ./', () => {
    const [finding] = toReviewBenchFindings([lensFinding('F1', { file: './src/a.ts' })], pr, AGENT).findings
    assert.equal(finding.file, 'src/a.ts')
  })

  test('a review that kept nothing is an empty findings array, not a failure', () => {
    assert.deepEqual(toReviewBenchFindings([], pr, AGENT).findings, [])
  })

  test('passes the run\'s usage through when given', () => {
    const output = toReviewBenchFindings([], pr, AGENT, { cost_usd: 2.5, time_in_ms: 1000 })
    assert.deepEqual(output.usage, { cost_usd: 2.5, time_in_ms: 1000 })
  })

  test('refuses a finding with no usable line, naming its id', () => {
    assert.throws(() => toReviewBenchFindings([lensFinding('F9', { line: undefined })], pr, AGENT), /F9/)
  })

  test('refuses a finding with no file or no description, naming its id', () => {
    assert.throws(() => toReviewBenchFindings([lensFinding('F8', { file: undefined })], pr, AGENT), /F8.*file/)
    assert.throws(() => toReviewBenchFindings([lensFinding('F7', { description: '' })], pr, AGENT), /F7.*description/)
  })

  test('refuses a pr without a 40-character head', () => {
    assert.throws(() => toReviewBenchFindings([lensFinding('F1')], { ...pr, head: 'abc' }, AGENT), /head/)
  })
})

// A stand-in for `claude` that records its arguments, working directory and environment, then
// prints a lens-review run as stream-json ending in the given result event (or none at all), with
// any extra raw lines before it. With `isReportBeforeStep6`, the report is an earlier assistant
// message and the run ends on Step 6's line, as a real run in the container does: the result
// event carries only claude's last message.
const STEP6_LINE = 'Not offered for posting: gh is not available.'

function assistantEvent(text) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

function writeFakeClaude(binDir, { findings = [lensFinding('F1')], result = {}, exitCode = 0, findingsLine = true, hasResultEvent = true, extraLines = [], isReportBeforeStep6 = false } = {}) {
  const runDir = makeTempDir('fake-lens-run')
  const finalFindingsPath = path.join(runDir, 'final-findings.json')
  fs.writeFileSync(finalFindingsPath, JSON.stringify(findings))
  const report = findingsLine ? `## Lens Review\n\nFindings JSON: ${finalFindingsPath}\n` : '## Lens Review\n\nNo findings file.\n'
  const lastMessage = isReportBeforeStep6 ? STEP6_LINE : report
  const resultEvent = { type: 'result', subtype: 'success', total_cost_usd: 2.5, duration_ms: 1000, result: lastMessage, ...result }
  const messages = isReportBeforeStep6 ? [report, STEP6_LINE] : [report]
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    ...extraLines,
    ...messages.map(message => JSON.stringify(assistantEvent(message))),
    ...(hasResultEvent ? [JSON.stringify(resultEvent)] : []),
  ]
  const script = [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" > "$FAKE_ARGS_FILE"',
    'printf "PWD=%s\\nLENS_REVIEW_HOME=%s\\nDISABLE_TELEMETRY=%s\\nCLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=%s\\n" "$PWD" "$LENS_REVIEW_HOME" "$DISABLE_TELEMETRY" "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" > "$FAKE_ENV_FILE"',
    `cat <<'EVENTS'\n${lines.join('\n')}\nEVENTS`,
    `exit ${exitCode}`,
  ].join('\n')
  const claudePath = path.join(binDir, 'claude')
  fs.writeFileSync(claudePath, `${script}\n`, { mode: 0o755 })
  return claudePath
}

describe('reviewbench/agent.mjs — one PR under ReviewBench\'s agent contract', () => {
  let repoDir
  let base
  let head
  let outDir
  let binDir
  let argsFile
  let envFile
  let env

  beforeEach(() => {
    // The checkout ReviewBench mounts: the PR's head, with its base reachable.
    repoDir = makeGitRepo({ 'src/a.ts': 'export const total = 1\n' }, { 'src/a.ts': 'export const total = 1\nexport const discount = 2\n' })
    base = git(repoDir, 'rev-parse', 'main')
    head = git(repoDir, 'rev-parse', 'feature')
    git(repoDir, 'checkout', '-q', '--detach', head)
    outDir = makeTempDir('reviewbench-out')
    binDir = makeTempDir('reviewbench-bin')
    argsFile = path.join(binDir, 'args.txt')
    envFile = path.join(binDir, 'env.txt')
    env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RB_NWO: NWO,
      RB_PR_NUMBER: String(PR_NUMBER),
      RB_BASE: base,
      RB_HEAD: head,
      RB_AGENT: AGENT,
      RB_REPO: repoDir,
      RB_OUT: path.join(outDir, 'findings.json'),
      RB_CONFIG_MAX_BUDGET_USD: BUDGET_USD,
      ANTHROPIC_API_KEY: 'test-key-not-real',
      FAKE_ARGS_FILE: argsFile,
      FAKE_ENV_FILE: envFile,
    }
  })

  function runAgent(fakeOptions) {
    return runScript('node', [AGENT_ENTRYPOINT], { env: { ...env, CLAUDE_BIN: writeFakeClaude(binDir, fakeOptions) } })
  }

  function assertRefusedBeforeClaude(result, messagePattern) {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, messagePattern)
    assert.equal(fs.existsSync(argsFile), false, 'claude must never start')
    assert.equal(fs.existsSync(env.RB_OUT), false)
  }

  test('refuses before starting claude when no per-PR budget is set', () => {
    delete env.RB_CONFIG_MAX_BUDGET_USD
    assertRefusedBeforeClaude(runAgent(), /^lens-review: .*RB_CONFIG_MAX_BUDGET_USD/m)
  })

  test('refuses before starting claude when the budget is zero or not a number', () => {
    for (const budget of ['0', 'lots']) {
      env.RB_CONFIG_MAX_BUDGET_USD = budget
      assertRefusedBeforeClaude(runAgent(), /^lens-review: .*RB_CONFIG_MAX_BUDGET_USD/m)
    }
  })

  test('refuses before starting claude when there is no credential at all', () => {
    delete env.ANTHROPIC_API_KEY
    assertRefusedBeforeClaude(runAgent(), /^lens-review: .*CLAUDE_CODE_OAUTH_TOKEN.*ANTHROPIC_API_KEY|^lens-review: .*ANTHROPIC_API_KEY.*CLAUDE_CODE_OAUTH_TOKEN/m)
  })

  test('runs on a Claude subscription token alone (claude setup-token), with no API key', () => {
    delete env.ANTHROPIC_API_KEY
    env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token-not-real'
    const result = runAgent()
    assert.equal(result.status, 0, result.stderr)
    assert.ok(fs.existsSync(argsFile))
  })

  test('refuses before starting claude when RB_OUT is missing', () => {
    delete env.RB_OUT
    assertRefusedBeforeClaude(runAgent(), /^lens-review: .*RB_OUT/m)
  })

  test('refuses before starting claude when RB_PR_NUMBER is not a positive integer', () => {
    env.RB_PR_NUMBER = 'seven'
    assertRefusedBeforeClaude(runAgent(), /^lens-review: .*RB_PR_NUMBER/m)
  })

  test('refuses before starting claude when the checkout is not at RB_HEAD', () => {
    git(repoDir, 'checkout', '-q', '--detach', base)
    assertRefusedBeforeClaude(runAgent(), /^lens-review: .*RB_HEAD/m)
  })

  test('runs lens-review headless against the PR base, capped, with posting and the web shut off', () => {
    const result = runAgent()
    assert.equal(result.status, 0, result.stderr)
    const args = readText(argsFile).split('\n')
    assert.equal(args[args.indexOf('-p') + 1], `/lens-review --base ${base}`)
    assert.equal(args[args.indexOf('--max-budget-usd') + 1], BUDGET_USD)
    assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5')
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json')
    // try-agent.sh adds an `upstream` remote at the real repo, whose later commits can hold the
    // fixes being scored, so reaching any remote through git is shut off too.
    const deniedRules = ['WebFetch', 'WebSearch', 'Bash(gh:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(git fetch:*)', 'Bash(git pull:*)', 'Bash(git remote:*)']
    for (const rule of deniedRules) assert.ok(args.includes(rule), `missing ${rule}`)
    const recordedEnv = readText(envFile)
    // Real paths, since macOS's temp dir is reached through a symlink.
    const recordedCwd = recordedEnv.match(/^PWD=(.*)$/m)[1]
    assert.equal(fs.realpathSync(recordedCwd), fs.realpathSync(repoDir))
    const lensHome = recordedEnv.match(/^LENS_REVIEW_HOME=(.*)$/m)[1]
    assert.ok(lensHome, 'every PR casts into a fresh LENS_REVIEW_HOME')
    assert.ok(!fs.realpathSync(lensHome).startsWith(fs.realpathSync(repoDir)), 'the team must not be written into the reviewed checkout')
    assert.match(recordedEnv, /^DISABLE_TELEMETRY=1$/m)
    assert.match(recordedEnv, /^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1$/m)
  })

  test('takes the model from RB_CONFIG_MODEL and prints the settings it applied', () => {
    env.RB_CONFIG_MODEL = 'claude-sonnet-5-5'
    const result = runAgent()
    assert.equal(result.status, 0, result.stderr)
    const args = readText(argsFile).split('\n')
    assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5')
    assert.match(`${result.stdout}${result.stderr}`, /model=claude-sonnet-5-5/)
    assert.match(`${result.stdout}${result.stderr}`, /max_budget_usd=4/)
  })

  test('writes RB_OUT in the contract\'s shape, with the run\'s cost, and keeps the stream log', () => {
    const result = runAgent()
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(readText(env.RB_OUT))
    assert.deepEqual(output.pr, { repo: `https://github.com/${NWO}`, pr_number: PR_NUMBER, base, head })
    assert.equal(output.agent, AGENT)
    assert.deepEqual(output.findings.map(finding => [finding.file, finding.start_line, finding.producer]), [['src/a.ts', 2, AGENT]])
    assert.deepEqual(output.usage, { cost_usd: 2.5, time_in_ms: 1000 })
    assert.match(readText(path.join(outDir, 'lens-review.log')), /"type":"result"/)
  })

  test('finds the report\'s Findings JSON line when Step 6 speaks after it, so the result event lacks it', () => {
    const result = runAgent({ isReportBeforeStep6: true })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readText(env.RB_OUT)).findings.map(finding => finding.start_line), [2])
  })

  test('a review that kept nothing writes an empty findings array and exits 0', () => {
    const result = runAgent({ findings: [] })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readText(env.RB_OUT)).findings, [])
  })

  test('fails without writing RB_OUT when claude exits non-zero', () => {
    const result = runAgent({ exitCode: 3 })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*claude/m)
    assert.equal(fs.existsSync(env.RB_OUT), false)
  })

  test('fails without writing RB_OUT when the run stopped at its budget cap', () => {
    const result = runAgent({ result: { subtype: 'error_max_budget_usd' } })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*error_max_budget_usd/m)
    assert.equal(fs.existsSync(env.RB_OUT), false)
  })

  test('fails without writing RB_OUT when claude\'s stream has no result event', () => {
    const result = runAgent({ hasResultEvent: false })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*result event/m)
    assert.equal(fs.existsSync(env.RB_OUT), false)
  })

  test('reports stream lines that are not JSON instead of skipping them silently', () => {
    const result = runAgent({ extraLines: ['not json at all'] })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /^lens-review: dropped 1 malformed stream line/m)
  })

  test('fails without writing RB_OUT when a kept finding cannot be converted, naming it', () => {
    const result = runAgent({ findings: [lensFinding('F9', { line: undefined })] })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*F9/m)
    assert.equal(fs.existsSync(env.RB_OUT), false)
  })

  test('fails without writing RB_OUT when the report has no Findings JSON line', () => {
    const result = runAgent({ findingsLine: false })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*Findings JSON/m)
    assert.equal(fs.existsSync(env.RB_OUT), false)
  })
})

describe('reviewbench/Dockerfile — the image ReviewBench runs once per PR', () => {
  let instructions

  beforeEach(() => {
    // Comments may mention what the image leaves out, so only the instructions are checked.
    instructions = readText(DOCKERFILE).split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  })

  test('pins Claude Code to one exact version', () => {
    assert.match(instructions, /@anthropic-ai\/claude-code@\d+\.\d+\.\d+(\s|$)/)
  })

  test('installs no gh, so no run can reach or post to a PR', () => {
    assert.doesNotMatch(instructions, /(^|\s)gh(\s|$)/m)
  })

  test('installs lens-review as the node user\'s only skill and runs as that user', () => {
    assert.match(instructions, /^COPY\s+skills\/lens-review\/?\s+\/home\/node\/\.claude\/skills\/lens-review\/?\s*$/m)
    assert.match(instructions, /^USER node\s*$/m)
  })

  test('starts the adapter with no arguments', () => {
    assert.match(instructions, /^ENTRYPOINT \["node", "\/agent\/agent\.mjs"\]\s*$/m)
  })

  test('keeps .git and node_modules out of the build context', () => {
    const rules = readText(DOCKERIGNORE).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    assert.ok(rules.includes('*') || rules.includes('**'), 'the ignore file must exclude everything by default')
    assert.ok(rules.some(rule => rule.startsWith('!skills/lens-review')), 'the skill must be re-included')
    assert.ok(!rules.some(rule => /^!(\.git|node_modules)/.test(rule)))
  })
})
