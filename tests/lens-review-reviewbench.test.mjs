import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, SKILL_DIR, git, makeGitRepo, makeTempDir, readText, runScript, writeFiles } from './helpers.mjs'

// The ReviewBench harness: fetches ReviewBench cases, runs lens-review on them behind an
// approval gate, converts its findings to ReviewBench's judging format and reports the judge's
// scores. Every test here runs offline: the ReviewBench checkout, its mirrors, `claude` and
// `npm` are local fakes, so no test can start a live review or a judge call.
const BENCH_DIR = path.join(REPO_ROOT, 'tests', 'lens-review-eval', 'reviewbench')
const CASES = path.join(BENCH_DIR, 'cases.mjs')
const TO_REVIEWBENCH = path.join(BENCH_DIR, 'to-reviewbench.mjs')
const LIVE_GATE = path.join(BENCH_DIR, 'live-gate.mjs')
const LEAK_CHECK = path.join(BENCH_DIR, 'leak-check.mjs')
const REPORT = path.join(BENCH_DIR, 'report.mjs')
const RUN_CASE = path.join(BENCH_DIR, 'run-case.sh')
const RUN_JUDGE = path.join(BENCH_DIR, 'run-judge.sh')

const AGENT = 'lens-review'
const NWO = 'acme/widgets'
const PR_NUMBER = 7
// The one tool rule every live run must carry, so no run can ever post to a PR.
const NO_PR_POSTING_RULE = 'Bash(gh api --method POST:*)'

function prKeyFor(head) {
  return `acme_widgets_${PR_NUMBER}-${head.slice(0, 8)}`
}

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

// A source repo with one PR on it: `main` is the PR's base, `feature` its head.
function makeSourceRepo() {
  const repoDir = makeGitRepo({ 'src/a.ts': 'export const total = 1\n' }, { 'src/a.ts': 'export const total = 1\nexport const discount = 2\n' })
  return { repoDir, base: git(repoDir, 'rev-parse', 'main'), head: git(repoDir, 'rev-parse', 'feature') }
}

function manifestEntry({ base, head }) {
  return {
    repo: `https://github.com/${NWO}`,
    pr_number: PR_NUMBER,
    pr_url: `https://github.com/${NWO}/pull/${PR_NUMBER}`,
    base,
    head,
    title: 'Add a discount',
    body: 'Adds the discount constant.',
    nwo: NWO,
    language: 'TypeScript',
    lines_added: 1,
    lines_removed: 0,
    files_changed: 1,
  }
}

// A ReviewBench checkout as the harness reads it: the manifest, the test set and one golden file.
function makeReviewBenchCheckout(entry) {
  const rbDir = makeTempDir('reviewbench-checkout')
  const key = prKeyFor(entry.head)
  const golden = {
    pr_key: key,
    pr: { repo: entry.repo, pr_number: entry.pr_number, base: entry.base, head: entry.head },
    findings: [{ file: 'src/a.ts', start_line: 2, end_line: 2, message: 'The discount is never applied.', tp_fp: 'tp', severity: 'medium', category: 'correctness', producer: 'llm_review:x' }],
  }
  writeFiles(rbDir, {
    'corpus/manifest.json': JSON.stringify([entry]),
    'corpus/test/test.json': JSON.stringify([entry]),
    [`golden/${key}.json`]: JSON.stringify(golden),
  })
  return { rbDir, key, golden }
}

// A materialized case dir, written by hand so the runner tests don't depend on cases.mjs.
function makeCaseDir({ repoDir, base, head }) {
  const caseDir = makeTempDir('reviewbench-case')
  const entry = manifestEntry({ base, head })
  writeFiles(caseDir, {
    'pr.json': JSON.stringify({ repo: entry.repo, pr_number: entry.pr_number, base, head, nwo: NWO, title: entry.title, body: entry.body }),
    'base.txt': `${base}\n`,
    'head.txt': `${head}\n`,
  })
  fs.renameSync(repoDir, path.join(caseDir, 'checkout'))
  git(path.join(caseDir, 'checkout'), 'checkout', '-q', '--detach', head)
  return caseDir
}

function writeApproval(workDir, approval) {
  writeFiles(workDir, { 'approval.json': JSON.stringify(approval) })
}

function readLedger(workDir) {
  const ledgerPath = path.join(workDir, 'ledger.jsonl')
  if (!fs.existsSync(ledgerPath)) return []
  return readText(ledgerPath).split('\n').filter(Boolean).map(line => JSON.parse(line))
}

// A stand-in for `claude` that records its arguments and environment, then prints a lens-review
// run as stream-json: the skill's base dir, any tool calls the test asks for, and the result.
function writeFakeClaude(binDir, { skillDir, toolUses = [], costUsd = 2.5, findings = [lensFinding('F1')] }) {
  const runDir = makeTempDir('fake-lens-run')
  const finalFindingsPath = path.join(runDir, 'final-findings.json')
  fs.writeFileSync(finalFindingsPath, JSON.stringify(findings))
  const events = [
    { type: 'system', subtype: 'init' },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${skillDir}` }] } },
    ...toolUses.map(toolUse => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', ...toolUse }] } })),
    { type: 'result', subtype: 'success', total_cost_usd: costUsd, result: `## Lens Review\n\nFindings JSON: ${finalFindingsPath}\n` },
  ]
  const script = [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" > "$FAKE_ARGS_FILE"',
    'printf "LENS_REVIEW_HOME=%s\\nPWD=%s\\n" "$LENS_REVIEW_HOME" "$PWD" > "$FAKE_ENV_FILE"',
    `cat <<'EVENTS'\n${events.map(event => JSON.stringify(event)).join('\n')}\nEVENTS`,
  ].join('\n')
  const claudePath = path.join(binDir, 'claude')
  fs.writeFileSync(claudePath, `${script}\n`, { mode: 0o755 })
  return claudePath
}

function writeFakeNpm(binDir) {
  const script = [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" > "$FAKE_ARGS_FILE"',
    'printf "PI_CODING_AGENT_DIR=%s\\n" "$PI_CODING_AGENT_DIR" > "$FAKE_ENV_FILE"',
  ].join('\n')
  const npmPath = path.join(binDir, 'npm')
  fs.writeFileSync(npmPath, `${script}\n`, { mode: 0o755 })
  return npmPath
}

describe('reviewbench/cases.mjs — turning a ReviewBench case into a lens-review input', () => {
  let cases
  let source
  let entry
  let checkout
  let casesDir
  let mirrorUrlTemplate

  beforeEach(async () => {
    cases = await import(CASES)
    source = makeSourceRepo()
    entry = manifestEntry(source)
    checkout = makeReviewBenchCheckout(entry)
    casesDir = makeTempDir('reviewbench-cases')
    // ReviewBench names each mirror review-bench/<owner>_<repo>; here the "mirror" is a local repo.
    const mirrorsRoot = makeTempDir('reviewbench-mirrors')
    fs.renameSync(source.repoDir, path.join(mirrorsRoot, 'acme_widgets'))
    mirrorUrlTemplate = path.join(mirrorsRoot, '{owner}_{repo}')
  })

  test('derives the same PR key ReviewBench names its golden files by', () => {
    const head = 'abcdef1234567890abcdef1234567890abcdef12'
    assert.equal(cases.prKey({ repo: `https://github.com/${NWO}`, pr_number: PR_NUMBER, head }), 'acme_widgets_7-abcdef12')
  })

  test('loads the 25-PR test set from corpus/test/test.json and the full set from the manifest', () => {
    assert.deepEqual(cases.loadSet(checkout.rbDir, 'test'), [entry])
    assert.deepEqual(cases.loadSet(checkout.rbDir, 'full'), [entry])
  })

  test('refuses a set name it does not know', () => {
    assert.throws(() => cases.loadSet(checkout.rbDir, 'everything'), /everything/)
  })

  test('materializes a case dir shaped like the other eval cases, checked out at the PR head', () => {
    const caseDir = cases.materializeCase({ rbDir: checkout.rbDir, key: checkout.key, casesDir, mirrorUrlTemplate })
    assert.equal(caseDir, path.join(casesDir, checkout.key))
    assert.equal(readText(path.join(caseDir, 'base.txt')).trim(), entry.base)
    assert.equal(readText(path.join(caseDir, 'head.txt')).trim(), entry.head)
    assert.deepEqual(JSON.parse(readText(path.join(caseDir, 'golden.json'))), checkout.golden)
    const pr = JSON.parse(readText(path.join(caseDir, 'pr.json')))
    assert.deepEqual(pr, { repo: entry.repo, pr_number: PR_NUMBER, base: entry.base, head: entry.head, nwo: NWO, title: entry.title, body: entry.body })
    const checkoutDir = path.join(caseDir, 'checkout')
    assert.equal(git(checkoutDir, 'rev-parse', 'HEAD'), entry.head)
    assert.equal(readText(path.join(caseDir, 'change.patch')).trim(), git(checkoutDir, 'diff', `${entry.base}...${entry.head}`))
  })

  test('leaves the checkout with no remote, so nothing in a review can reach the upstream PR', () => {
    const caseDir = cases.materializeCase({ rbDir: checkout.rbDir, key: checkout.key, casesDir, mirrorUrlTemplate })
    assert.equal(git(path.join(caseDir, 'checkout'), 'remote'), '')
  })

  test('refuses a PR key that is not in the manifest, naming it', () => {
    assert.throws(() => cases.materializeCase({ rbDir: checkout.rbDir, key: 'nobody_nothing_1-00000000', casesDir, mirrorUrlTemplate }), /nobody_nothing_1-00000000/)
  })

  test('refuses a case whose golden file is missing', () => {
    fs.rmSync(path.join(checkout.rbDir, 'golden', `${checkout.key}.json`))
    assert.throws(() => cases.materializeCase({ rbDir: checkout.rbDir, key: checkout.key, casesDir, mirrorUrlTemplate }), /golden/)
  })

  test('refuses a case whose mirror cannot be cloned, naming the mirror', () => {
    const missingTemplate = path.join(makeTempDir('no-mirrors'), '{owner}_{repo}')
    assert.throws(() => cases.materializeCase({ rbDir: checkout.rbDir, key: checkout.key, casesDir, mirrorUrlTemplate: missingTemplate }), /acme_widgets/)
  })
})

describe('reviewbench/to-reviewbench.mjs — lens-review findings in the judge\'s input format', () => {
  let toReviewBenchFindings
  let pr

  beforeEach(async () => {
    ;({ toReviewBenchFindings } = await import(TO_REVIEWBENCH))
    pr = { repo: `https://github.com/${NWO}`, pr_number: PR_NUMBER, base: 'a'.repeat(40), head: 'b'.repeat(40), nwo: NWO }
  })

  test('maps each kept finding onto one ReviewBench finding at its line', () => {
    const output = toReviewBenchFindings([lensFinding('F1')], pr, AGENT)
    assert.deepEqual(output, {
      pr: { repo: pr.repo, pr_number: PR_NUMBER, base: pr.base, head: pr.head },
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

  test('refuses a finding with no usable line, naming its id', () => {
    assert.throws(() => toReviewBenchFindings([lensFinding('F9', { line: undefined })], pr, AGENT), /F9/)
  })

  test('refuses a case whose pr.json lacks a 40-character head', () => {
    assert.throws(() => toReviewBenchFindings([lensFinding('F1')], { ...pr, head: 'abc' }, AGENT), /head/)
  })
})

describe('reviewbench/live-gate.mjs — no live run without an approved count and budget', () => {
  let checkGate
  let approval

  beforeEach(async () => {
    ;({ checkGate } = await import(LIVE_GATE))
    approval = { review: { count: 3, maxUsd: 15 }, judge: { count: 3, maxUsd: 6 }, approvedOn: '2026-10-25' }
  })

  test('allows a run inside the approved count and budget', () => {
    const verdict = checkGate({ kind: 'review', requested: 3, estimateUsd: 4, approval, ledger: [] })
    assert.equal(verdict.allowed, true)
  })

  test('refuses when there is no approval at all', () => {
    const verdict = checkGate({ kind: 'review', requested: 1, estimateUsd: 4, approval: null, ledger: [] })
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /approval\.json/)
  })

  test('refuses a kind the approval does not cover', () => {
    const verdict = checkGate({ kind: 'judge', requested: 1, estimateUsd: 1, approval: { review: approval.review }, ledger: [] })
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /judge/)
  })

  test('refuses a malformed approval instead of reading it as unlimited', () => {
    const verdict = checkGate({ kind: 'review', requested: 1, estimateUsd: 4, approval: { review: { count: 'lots', maxUsd: 15 } }, ledger: [] })
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /count/)
  })

  test('counts runs already started against the approved count', () => {
    const ledger = [
      { kind: 'review', run: 'pilot', key: 'k1', event: 'start', estimatedUsd: 4 },
      { kind: 'review', run: 'pilot', key: 'k1', event: 'end', actualUsd: 2 },
      { kind: 'review', run: 'pilot', key: 'k2', event: 'start', estimatedUsd: 4 },
    ]
    const verdict = checkGate({ kind: 'review', requested: 2, estimateUsd: 1, approval, ledger })
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /count/)
  })

  test('charges a crashed run its estimate, a finished one its actual cost', () => {
    const ledger = [
      { kind: 'review', run: 'pilot', key: 'k1', event: 'start', estimatedUsd: 4 },
      { kind: 'review', run: 'pilot', key: 'k1', event: 'end', actualUsd: 2 },
      { kind: 'review', run: 'pilot', key: 'k2', event: 'start', estimatedUsd: 4 },
    ]
    // Spent: 2 (actual) + 4 (estimate of the crashed run) = 6; one more at 10 would reach 16 > 15.
    assert.equal(checkGate({ kind: 'review', requested: 1, estimateUsd: 10, approval, ledger }).allowed, false)
    assert.equal(checkGate({ kind: 'review', requested: 1, estimateUsd: 9, approval, ledger }).allowed, true)
  })

  test('refuses a missing or non-positive estimate, since a zero estimate would make the budget check a no-op', () => {
    for (const estimateUsd of [undefined, 0, -1]) {
      const verdict = checkGate({ kind: 'review', requested: 1, estimateUsd, approval, ledger: [] })
      assert.equal(verdict.allowed, false)
      assert.match(verdict.reason, /estimate/)
    }
  })

  test('charges a run that ended without an actual cost (every judge run) its estimate', () => {
    const ledger = [
      { kind: 'judge', run: 'pilot', key: 'k1', event: 'start', estimatedUsd: 3 },
      { kind: 'judge', run: 'pilot', key: 'k1', event: 'end', actualUsd: null },
    ]
    // Spent: 3 (the estimate, since the judge reports no cost); one more at 4 would reach 7 > 6.
    assert.equal(checkGate({ kind: 'judge', requested: 1, estimateUsd: 4, approval, ledger }).allowed, false)
    assert.equal(checkGate({ kind: 'judge', requested: 1, estimateUsd: 3, approval, ledger }).allowed, true)
  })

  test('the CLI reserve records the start in the same step as the check, so the next reserve sees it', () => {
    const workDir = makeTempDir('reviewbench-work')
    writeApproval(workDir, { review: { count: 1, maxUsd: 10 } })
    const reserve = key => runScript('node', [LIVE_GATE, 'reserve', '--work', workDir, '--kind', 'review', '--run', 'pilot', '--key', key, '--count', '1', '--estimate-usd', '4'])
    assert.equal(reserve('k1').status, 0)
    assert.deepEqual(readLedger(workDir).map(entry => [entry.event, entry.key, entry.estimatedUsd]), [['start', 'k1', 4]])
    const second = reserve('k2')
    assert.notEqual(second.status, 0)
    assert.match(second.stderr, /^lens-review: .*count/m)
    assert.equal(readLedger(workDir).length, 1)
  })

  test('the CLI exits non-zero with a lens-review: message when the work dir holds no approval', () => {
    const workDir = makeTempDir('reviewbench-work')
    const result = runScript('node', [LIVE_GATE, 'check', '--work', workDir, '--kind', 'review', '--count', '1', '--estimate-usd', '4'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*approval\.json/m)
  })
})

describe('reviewbench/leak-check.mjs — a review that looked up the upstream PR is not a score', () => {
  let findLeaks

  beforeEach(async () => {
    ;({ findLeaks } = await import(LEAK_CHECK))
  })

  function streamOf(...toolUses) {
    return toolUses.map(toolUse => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', ...toolUse }] } })).join('\n')
  }

  test('passes a run whose tools only read the checkout, even when they grep for github.com', () => {
    const log = streamOf({ name: 'Read', input: { file_path: 'src/a.ts' } }, { name: 'Bash', input: { command: 'grep -rn github.com src' } })
    assert.deepEqual(findLeaks(log), [])
  })

  test('flags a Bash call that fetches from GitHub', () => {
    const log = streamOf({ name: 'Bash', input: { command: `curl -s https://api.github.com/repos/${NWO}/pulls/${PR_NUMBER}/comments` } })
    assert.equal(findLeaks(log).length, 1)
  })

  test('flags any web tool call', () => {
    const log = streamOf({ name: 'WebFetch', input: { url: 'https://example.com' } }, { name: 'WebSearch', input: { query: `${NWO} pull ${PR_NUMBER}` } })
    assert.equal(findLeaks(log).length, 2)
  })

  test('passes lens-review\'s own current-branch PR lookup, which cannot reach a PR from a checkout with no remote', () => {
    const log = streamOf({ name: 'Bash', input: { command: 'gh pr view --json url,headRefOid' } })
    assert.deepEqual(findLeaks(log), [])
  })

  test('flags a gh call that names a PR or a repo', () => {
    const log = streamOf(
      { name: 'Bash', input: { command: `gh pr view https://github.com/${NWO}/pull/${PR_NUMBER} --json comments` } },
      { name: 'Bash', input: { command: `gh pr view ${PR_NUMBER} -R ${NWO}` } },
      { name: 'Bash', input: { command: `gh api repos/${NWO}/pulls/${PR_NUMBER}/comments` } },
    )
    assert.equal(findLeaks(log).length, 3)
  })

  test('flags any MCP tool call', () => {
    const log = streamOf({ name: 'mcp__github__get_pull_request', input: { owner: 'acme', repo: 'widgets', pullNumber: PR_NUMBER } })
    assert.equal(findLeaks(log).length, 1)
  })

  test('refuses a log line that is not JSON rather than skipping it', () => {
    assert.throws(() => findLeaks('{"type":"system"}\nnot json'), /line 2/)
  })
})

describe('reviewbench/report.mjs — reading the judge\'s results', () => {
  let summarizeJudgeResults
  let results

  beforeEach(async () => {
    ;({ summarizeJudgeResults } = await import(REPORT))
    const overall = { grounded_precision: 0.5, grounded_recall: 0.25, augmented_precision: 0.75, augmented_recall: 0.4 }
    results = {
      macro: { overall, by_severity: { high: overall }, by_category: { security: overall } },
      micro: { overall, by_severity: {}, by_category: {} },
      pr_count: 2,
      per_pr: [{ pr_key: 'k1' }, { pr_key: 'k2' }],
      eval_config: { classifier_model: 'anthropic/claude-sonnet-5', matcher_model: 'anthropic/claude-sonnet-5' },
    }
  })

  test('summarizes macro precision and recall, the judge model and the PR count', () => {
    const summary = summarizeJudgeResults(results, ['k1', 'k2'])
    assert.equal(summary.prCount, 2)
    assert.deepEqual(summary.missingKeys, [])
    assert.equal(summary.overall.grounded_recall, 0.25)
    assert.equal(summary.overall.augmented_precision, 0.75)
    assert.equal(summary.judgeModel, 'anthropic/claude-sonnet-5')
    assert.equal(summary.bySeverity.high.grounded_precision, 0.5)
  })

  test('keeps a null metric (a PR with no golden TPs) as null rather than zero', () => {
    results.macro.overall.grounded_recall = null
    assert.equal(summarizeJudgeResults(results, ['k1', 'k2']).overall.grounded_recall, null)
  })

  test('lists the PRs that have findings but no judge score, since the judge drops them silently', () => {
    const summary = summarizeJudgeResults(results, ['k1', 'k2', 'k3'])
    assert.deepEqual(summary.missingKeys, ['k3'])
  })

  test('refuses a file that is not a ReviewBench results file', () => {
    assert.throws(() => summarizeJudgeResults({ pr_count: 2 }, ['k1']), /macro\.overall/)
  })

  test('the CLI names the missing results file and points at the checkpoint to resume', () => {
    const runDir = makeTempDir('reviewbench-run')
    writeFiles(runDir, { 'scoring/results.checkpoint.json': '{}', 'findings/k1.json': '{}' })
    const result = runScript('node', [REPORT, '--results', path.join(runDir, 'scoring', 'results.json'), '--findings', path.join(runDir, 'findings')])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*results\.json/m)
    assert.match(result.stderr, /checkpoint/)
  })

  test('the CLI refuses malformed judge output', () => {
    const runDir = makeTempDir('reviewbench-run')
    writeFiles(runDir, { 'scoring/results.json': '{"macro": ', 'findings/k1.json': '{}' })
    const result = runScript('node', [REPORT, '--results', path.join(runDir, 'scoring', 'results.json'), '--findings', path.join(runDir, 'findings')])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*not valid JSON/m)
  })

  test('the CLI prints the report but exits non-zero on a coverage gap', () => {
    const runDir = makeTempDir('reviewbench-run')
    writeFiles(runDir, { 'scoring/results.json': JSON.stringify(results), 'findings/k1.json': '{}', 'findings/k2.json': '{}', 'findings/k3.json': '{}' })
    const result = runScript('node', [REPORT, '--results', path.join(runDir, 'scoring', 'results.json'), '--findings', path.join(runDir, 'findings')])
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /0\.25/)
    assert.match(result.stderr, /k3/)
  })
})

describe('reviewbench/run-case.sh — one gated, isolated live review', () => {
  let workDir
  let binDir
  let caseDir
  let key
  let argsFile
  let envFile

  beforeEach(() => {
    workDir = makeTempDir('reviewbench-work')
    binDir = makeTempDir('reviewbench-bin')
    const source = makeSourceRepo()
    key = prKeyFor(source.head)
    caseDir = makeCaseDir(source)
    argsFile = path.join(binDir, 'args.txt')
    envFile = path.join(binDir, 'env.txt')
  })

  function runCase(claudePath) {
    return runScript('bash', [RUN_CASE, caseDir, 'pilot'], {
      env: { ...process.env, REVIEWBENCH_WORK: workDir, CLAUDE_BIN: claudePath, LENS_SKILL_DIR: SKILL_DIR, REVIEWBENCH_REVIEW_ESTIMATE_USD: '4', FAKE_ARGS_FILE: argsFile, FAKE_ENV_FILE: envFile },
    })
  }

  test('refuses before starting claude when no run is approved', () => {
    const result = runCase(writeFakeClaude(binDir, { skillDir: SKILL_DIR }))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*approval\.json/m)
    assert.equal(fs.existsSync(argsFile), false)
    assert.deepEqual(readLedger(workDir), [])
  })

  test('runs lens-review headless against the PR base, with PR posting and the web shut off', () => {
    writeApproval(workDir, { review: { count: 1, maxUsd: 10 } })
    const result = runCase(writeFakeClaude(binDir, { skillDir: SKILL_DIR }))
    assert.equal(result.status, 0, result.stderr)
    const args = readText(argsFile).split('\n')
    const base = readText(path.join(caseDir, 'base.txt')).trim()
    assert.ok(args.includes('-p'))
    assert.ok(args.includes(`/lens-review --base ${base}`))
    for (const rule of [NO_PR_POSTING_RULE, 'Bash(gh:*)', 'WebFetch', 'WebSearch']) assert.ok(args.includes(rule), `missing ${rule}`)
    // The per-run cap is the same number the gate charged for the run.
    assert.equal(args[args.indexOf('--max-budget-usd') + 1], '4')
    assert.ok(args.includes('stream-json'))
    // Only project settings (the linked skill), and no MCP servers: the developer's own CLAUDE.md,
    // plugins, hooks and MCP servers must not shape or leak into a benchmark run.
    assert.equal(args[args.indexOf('--setting-sources') + 1], 'project')
    assert.ok(args.includes('--strict-mcp-config'))
    assert.ok(!args.includes('--dangerously-skip-permissions'))
    assert.ok(!args.includes('bypassPermissions'))
    const env = readText(envFile)
    assert.match(env, new RegExp(`LENS_REVIEW_HOME=${workDir}/`))
    assert.match(env, /PWD=.*\/checkout$/m)
  })

  test('saves the kept findings, the judge-format file and the actual cost', () => {
    writeApproval(workDir, { review: { count: 1, maxUsd: 10 } })
    const result = runCase(writeFakeClaude(binDir, { skillDir: SKILL_DIR, costUsd: 2.5 }))
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readText(path.join(caseDir, 'runs', 'pilot.json'))).map(finding => finding.id), ['F1'])
    const converted = JSON.parse(readText(path.join(workDir, 'runs', 'pilot', 'findings', `${key}.json`)))
    assert.equal(converted.agent, AGENT)
    assert.equal(converted.findings.length, 1)
    const ledger = readLedger(workDir)
    assert.deepEqual(ledger.map(entry => entry.event), ['start', 'end'])
    assert.equal(ledger[1].actualUsd, 2.5)
  })

  test('refuses a second run once the approved count is used up', () => {
    writeApproval(workDir, { review: { count: 1, maxUsd: 10 } })
    const claudePath = writeFakeClaude(binDir, { skillDir: SKILL_DIR })
    assert.equal(runCase(claudePath).status, 0)
    fs.rmSync(argsFile)
    const second = runCase(claudePath)
    assert.notEqual(second.status, 0)
    assert.match(second.stderr, /^lens-review: .*count/m)
    assert.equal(fs.existsSync(argsFile), false)
  })

  test('refuses before starting claude when the checkout carries its own Claude Code settings', () => {
    writeApproval(workDir, { review: { count: 1, maxUsd: 10 } })
    writeFiles(path.join(caseDir, 'checkout'), { '.claude/settings.json': JSON.stringify({ hooks: {} }) })
    const result = runCase(writeFakeClaude(binDir, { skillDir: SKILL_DIR }))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*\.claude\/settings\.json/m)
    assert.equal(fs.existsSync(argsFile), false)
    assert.deepEqual(readLedger(workDir), [])
  })

  test('drops a run that reached GitHub instead of scoring it', () => {
    writeApproval(workDir, { review: { count: 1, maxUsd: 10 } })
    const toolUses = [{ name: 'Bash', input: { command: `curl https://api.github.com/repos/${NWO}/pulls/${PR_NUMBER}/comments` } }]
    const result = runCase(writeFakeClaude(binDir, { skillDir: SKILL_DIR, toolUses }))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*github/im)
    assert.equal(fs.existsSync(path.join(workDir, 'runs', 'pilot', 'findings', `${key}.json`)), false)
    assert.equal(readLedger(workDir).at(-1).event, 'end')
  })

  test('drops a run that loaded some other copy of lens-review', () => {
    writeApproval(workDir, { review: { count: 1, maxUsd: 10 } })
    const result = runCase(writeFakeClaude(binDir, { skillDir: '/somewhere/else/lens-review' }))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*\/somewhere\/else\/lens-review/m)
    assert.equal(fs.existsSync(path.join(workDir, 'runs', 'pilot', 'findings', `${key}.json`)), false)
  })
})

describe('reviewbench/run-judge.sh — one gated judge run', () => {
  let workDir
  let binDir
  let rbDir
  let argsFile
  let envFile

  beforeEach(() => {
    workDir = makeTempDir('reviewbench-work')
    binDir = makeTempDir('reviewbench-bin')
    rbDir = makeTempDir('reviewbench-checkout')
    argsFile = path.join(binDir, 'args.txt')
    envFile = path.join(binDir, 'env.txt')
    writeFiles(workDir, { 'runs/pilot/findings/k1.json': '{}', 'runs/pilot/findings/k2.json': '{}' })
  })

  function runJudge() {
    return runScript('bash', [RUN_JUDGE, 'pilot'], {
      env: { ...process.env, REVIEWBENCH_WORK: workDir, REVIEWBENCH_RB: rbDir, NPM_BIN: writeFakeNpm(binDir), REVIEWBENCH_JUDGE_ESTIMATE_USD: '1', FAKE_ARGS_FILE: argsFile, FAKE_ENV_FILE: envFile },
    })
  }

  test('refuses before calling the judge when no judge run is approved', () => {
    writeApproval(workDir, { review: { count: 2, maxUsd: 10 } })
    const result = runJudge()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*judge/m)
    assert.equal(fs.existsSync(argsFile), false)
  })

  test('judges the run\'s findings with the leaderboard\'s judge model', () => {
    writeApproval(workDir, { judge: { count: 2, maxUsd: 5 } })
    const result = runJudge()
    assert.equal(result.status, 0, result.stderr)
    const args = readText(argsFile).split('\n')
    const runDir = path.join(workDir, 'runs', 'pilot')
    assert.deepEqual(args.slice(0, 3), ['--prefix', rbDir, 'run'])
    assert.ok(args.includes('judge'))
    assert.equal(args[args.indexOf('--candidate') + 1], path.join(runDir, 'findings'))
    assert.equal(args[args.indexOf('--provider') + 1], 'anthropic')
    assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5')
    assert.equal(args[args.indexOf('--output') + 1], path.join(runDir, 'scoring', 'results.json'))
    const piDir = readText(envFile).match(/^PI_CODING_AGENT_DIR=(.*)$/m)[1]
    assert.ok(fs.existsSync(path.join(piDir, 'models.json')), 'the judge model must be registered for pi')
  })

  test('refuses a run whose findings outnumber the approved judge count', () => {
    writeApproval(workDir, { judge: { count: 1, maxUsd: 5 } })
    const result = runJudge()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*count/m)
    assert.equal(fs.existsSync(argsFile), false)
  })
})
