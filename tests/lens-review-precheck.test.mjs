import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, SCRIPTS_DIR, git, makeGitRepo, makeTempDir, readText, runScript, writeFiles } from './helpers.mjs'
import { parseDiffFiles } from '../skills/lens-review/scripts/lib/diff.mjs'
import { openRepo } from '../skills/lens-review/scripts/lib/repo.mjs'
import { untestedFailurePath } from '../skills/lens-review/scripts/prechecks/untested-failure-path.mjs'
import { duplicateInDiff } from '../skills/lens-review/scripts/prechecks/duplicate-in-diff.mjs'
import { newlyUnused } from '../skills/lens-review/scripts/prechecks/newly-unused.mjs'
import { migrationOrder } from '../skills/lens-review/scripts/prechecks/migration-order.mjs'
import { uncheckedField } from '../skills/lens-review/scripts/prechecks/unchecked-field.mjs'
import { scoreRecall } from './lens-review-eval/score-recall.mjs'

const PRECHECK = path.join(SCRIPTS_DIR, 'precheck.mjs')
const EVAL_DIR = path.join(REPO_ROOT, 'tests', 'lens-review-eval')
// The spec's budget for the whole precheck pass on one PR.
const PRECHECK_TIME_LIMIT_MS = 5000
const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024

// A repo whose `feature` branch makes the change, plus what a check reads: the parsed diff and
// the repo at the feature head.
// main always holds a README: git cannot commit an empty base.
function fixtureRepo(filesOnMain, filesOnFeature) {
  return makeGitRepo({ 'README.md': 'fixture\n', ...filesOnMain }, filesOnFeature)
}

function changeOf(filesOnMain, filesOnFeature, { planDocs = [] } = {}) {
  const repoDir = fixtureRepo(filesOnMain, filesOnFeature)
  const patch = git(repoDir, 'diff', '--src-prefix=a/', '--dst-prefix=b/', 'main...feature')
  const repo = openRepo(repoDir, git(repoDir, 'rev-parse', 'HEAD'))
  return { diffFiles: parseDiffFiles(`${patch}\n`), repo, planDocs: planDocs.map(planDoc => ({ path: planDoc, text: repo.read(planDoc) })) }
}

function lines(...items) {
  return `${items.join('\n')}\n`
}

const LOOP_BODY = [
  '  for (const stem of stems) {',
  '    try {',
  "      const parsed = parseReply(path.join(runDir, `reply-${stem}.txt`))",
  "      writeJson(path.join(runDir, `out-${stem}.json`), parsed)",
  '      results.push(parsed)',
  '    } catch (error) {',
  '      failed.push({ stem, reason: error.message })',
  '    }',
  '  }',
]

describe('lib/diff.mjs parseDiffFiles', () => {
  test('lists each file with its added lines on the new side and whether it is new', () => {
    const { diffFiles } = changeOf({ 'a.js': lines('one', 'two', 'three') }, { 'a.js': lines('one', 'TWO', 'three'), 'b.js': lines('new') })
    const changed = diffFiles.find(file => file.path === 'a.js')
    assert.deepEqual(changed.added, [{ line: 2, text: 'TWO' }])
    assert.deepEqual(changed.removed.map(removal => removal.text), ['two'])
    assert.equal(changed.isNew, false)
    assert.equal(diffFiles.find(file => file.path === 'b.js').isNew, true)
  })
})

describe('prechecks/untested-failure-path.mjs', () => {
  test('flags an error message the diff adds that no test mentions', () => {
    const change = changeOf(
      { 'tests/a.test.js': lines("test('x', () => {})") },
      { 'src/a.js': lines('export function a(x) {', "  if (!x) throw new Error('the widget is missing its spindle')", '}') },
    )
    const [finding] = untestedFailurePath(change)
    assert.equal(finding.file, 'src/a.js')
    assert.equal(finding.line, 2)
    assert.equal(finding.check, 'untested-failure-path')
    assert.equal(finding.reviewer, 'Precheck')
    assert.equal(finding.category, 'tests')
  })

  test('stays quiet when a test names a distinctive part of the message, even around a placeholder', () => {
    const change = changeOf(
      { 'tests/a.test.js': lines('assert.throws(run, /is not one of the group\\x27s areas/)') },
      {
        'db/seed.sql': lines("  raise exception 'area % is not one of the group''s areas %', v_area, v_areas;"),
        'src/a.js': lines('export const b = () => {', "  throw new Error(`${name} is not one of the group's areas`)", '}'),
        'tests/a.test.js': lines("assert.throws(run, /is not one of the group's areas/)"),
      },
    )
    assert.deepEqual(untestedFailurePath(change), [])
  })

  test('counts a test that quotes the message inside a regex, with its slashes escaped', () => {
    const change = changeOf(
      { 'tests/a.test.js': lines('assert.match(result.stderr, /gave no keep\\/drop verdict for F1/)') },
      { 'src/a.js': lines("  throw new Error(`the skeptic gave no keep/drop verdict for ${ids}`)") },
    )
    assert.deepEqual(untestedFailurePath(change), [])
  })

  test('flags a SQL raise exception that no test mentions', () => {
    const change = changeOf({}, { 'db/seed.sql': lines('begin', "  raise exception 'no practice on weekday % yet', v_day;", 'end') })
    assert.equal(untestedFailurePath(change)[0]?.line, 2)
  })

  test('leaves a message the diff only moves from one call to another alone', () => {
    const change = changeOf(
      { 'src/a.js': lines("  fail(`${replyPath} is not a JSON reply at all`)") },
      { 'src/a.js': lines("  throw new Error(`${replyPath} is not a JSON reply at all`)") },
    )
    assert.deepEqual(untestedFailurePath(change), [])
  })

  test('leaves usage errors and errors thrown by test code itself alone', () => {
    const change = changeOf(
      {},
      {
        'src/cli.js': lines("fail('usage: cli.js <run-dir> [--flag]')"),
        'e2e/setup.spec.ts': lines("throw new Error('standing setup step failed badly')"),
      },
    )
    assert.deepEqual(untestedFailurePath(change), [])
  })
})

describe('prechecks/duplicate-in-diff.mjs', () => {
  test('flags a block copied between two files the diff adds, pointing at the first copy', () => {
    const change = changeOf(
      {},
      {
        'src/collect-a.js': lines('export function collectA(runDir, stems) {', '  const results = []', '  const failed = []', ...LOOP_BODY, '  return results', '}'),
        'src/collect-b.js': lines(
          'export function collectB(runDir, names) {',
          '  const ballots = []',
          ...LOOP_BODY.map(line => line.replaceAll('stems', 'names').replaceAll('results', 'ballots')),
          '  return ballots',
          '}',
        ),
      },
    )
    const [finding, ...rest] = duplicateInDiff(change)
    assert.equal(rest.length, 0)
    assert.equal(finding.file, 'src/collect-b.js')
    assert.equal(finding.category, 'duplication')
    assert.match(finding.duplicates, /^src\/collect-a\.js:\d+$/)
  })

  test('does not flag a shared block of five lines or fewer', () => {
    const shortBlock = LOOP_BODY.slice(1, 6)
    const change = changeOf(
      {},
      {
        'src/a.js': lines('let total = 0', ...shortBlock, "return [total, 'a']"),
        'src/b.js': lines('while (queue.length > 0) queue.pop()', ...shortBlock, 'export default 2'),
      },
    )
    assert.deepEqual(duplicateInDiff(change), [])
  })

  test('does not flag two places in one test file, which repeat their shape by design', () => {
    const testBody = LOOP_BODY.map(line => line.replace('results', 'seen'))
    const change = changeOf({}, { 'tests/a.test.js': lines("test('one', () => {", ...testBody, '})', '', "test('two', () => {", ...testBody, '})') })
    assert.deepEqual(duplicateInDiff(change), [])
  })

  test('does not flag copies inside test fixtures', () => {
    const block = lines('function c() {', ...LOOP_BODY, '}')
    const change = changeOf({}, { 'tests/fixtures/one/c.js': block, 'tests/fixtures/two/c.js': block })
    assert.deepEqual(duplicateInDiff(change), [])
  })

  test('does not flag two different blocks of the same length', () => {
    const change = changeOf(
      {},
      {
        'src/a.js': lines('function a(list) {', ...LOOP_BODY, '}'),
        'src/b.js': lines(
          'function b(rows) {',
          '  const total = rows.reduce((sum, row) => sum + row.amount, 0)',
          '  if (total > LIMIT) return null',
          "  const label = total.toFixed(2) + ' due'",
          '  for (const row of rows) row.share = row.amount / total',
          '  rows.sort((first, second) => second.share - first.share)',
          '  const top = rows.slice(0, 3)',
          '  log(label, top.length)',
          '  return { total, top }',
          '}',
        ),
      },
    )
    assert.deepEqual(duplicateInDiff(change), [])
  })
})

describe('prechecks/newly-unused.mjs', () => {
  test('flags a function whose last caller the diff removes while its definition stays', () => {
    const change = changeOf(
      { 'src/lib.js': lines('export function oldHelper() {', '  return 1', '}'), 'src/use.js': lines("import { oldHelper } from './lib.js'", 'oldHelper()') },
      { 'src/use.js': lines('// no longer needed') },
    )
    const [finding] = newlyUnused(change)
    assert.equal(finding.check, 'newly-unused')
    assert.match(finding.description, /oldHelper/)
    assert.equal(finding.file, 'src/use.js')
  })

  test('flags a CLI flag the diff adds that nothing but its own script and tests passes', () => {
    const change = changeOf(
      { 'SKILL.md': lines('Run `node tool.mjs <in>`.') },
      {
        'scripts/tool.mjs': lines("const flagIndex = process.argv.indexOf('--default-owner')", 'console.log(flagIndex)'),
        'tests/tool.test.mjs': lines("run(['--default-owner', 'x'])"),
      },
    )
    const [finding] = newlyUnused(change)
    assert.match(finding.description, /--default-owner/)
    assert.equal(finding.file, 'scripts/tool.mjs')
    assert.equal(finding.line, 1)
  })

  test('stays quiet while another caller remains, or the new flag is passed somewhere', () => {
    const change = changeOf(
      {
        'src/lib.js': lines('export function helper() {', '  return 1', '}'),
        'src/use.js': lines('helper()'),
        'src/other.js': lines('helper()'),
        'SKILL.md': lines('Run `node tool.mjs`.'),
      },
      {
        'src/use.js': lines('// gone'),
        'scripts/tool.mjs': lines("const flagIndex = process.argv.indexOf('--owner')"),
        'SKILL.md': lines('Run `node tool.mjs --owner <name>`.'),
      },
    )
    assert.deepEqual(newlyUnused(change), [])
  })
})

describe('prechecks/migration-order.mjs', () => {
  const existing = { 'db/migrations/20260101000000_init.sql': lines('create table a ();') }

  test('flags a new migration that sorts before one already merged', () => {
    const change = changeOf(
      { ...existing, 'db/migrations/20260301000000_later.sql': lines('create table b ();') },
      { 'db/migrations/20260201000000_new.sql': lines('create table c ();') },
    )
    const [finding] = migrationOrder(change)
    assert.equal(finding.file, 'db/migrations/20260201000000_new.sql')
    assert.equal(finding.line, 1)
    assert.match(finding.description, /20260301000000_later/)
  })

  test('flags a new migration that sorts after a planned one the plan doc names but nothing has merged', () => {
    const change = changeOf(existing, {
      'db/migrations/20260201000001_second.sql': lines('create table c ();'),
      'docs/tech-design-x.md': lines('- M0 adds `20260201000000_first.sql` — needs: none', '- M1 adds `20260201000001_second.sql`'),
    }, { planDocs: ['docs/tech-design-x.md'] })
    const [finding, ...rest] = migrationOrder(change)
    assert.equal(rest.length, 0)
    assert.match(finding.description, /20260201000000_first/)
    assert.equal(finding.category, 'data')
  })

  test('stays quiet when the new migration sorts after every merged and planned one', () => {
    const change = changeOf(existing, {
      'db/migrations/20260201000000_new.sql': lines('create table c ();'),
      'docs/plan.md': lines('Ships `20260101000000_init.sql` first, then `20260201000000_new.sql`.'),
    }, { planDocs: ['docs/plan.md'] })
    assert.deepEqual(migrationOrder(change), [])
  })
})

describe('prechecks/unchecked-field.mjs', () => {
  test('flags an optional string method on a field nothing type-checks', () => {
    const change = changeOf({}, { 'src/merge.js': lines('function keys(finding) {', "  return finding.duplicates?.split(':')[0]", '}') })
    const [finding] = uncheckedField(change)
    assert.equal(finding.line, 2)
    assert.match(finding.description, /finding\.duplicates/)
    assert.equal(finding.category, 'reliability')
  })

  test('stays quiet when the file checks the field\'s type', () => {
    const change = changeOf(
      {},
      {
        'src/merge.js': lines(
          "const isValid = finding => finding.duplicates === undefined || typeof finding.duplicates === 'string'",
          "const key = finding => finding.duplicates?.split(':')[0]",
        ),
      },
    )
    assert.deepEqual(uncheckedField(change), [])
  })
})

describe('precheck.mjs', () => {
  test('writes every check\'s findings to precheck.json and summarises them', () => {
    const repoDir = fixtureRepo({}, { 'src/merge.js': lines("export const key = finding => finding.duplicates?.split(':')[0]") })
    const runDir = makeTempDir('precheck-run')
    fs.writeFileSync(path.join(runDir, 'diff.patch'), `${git(repoDir, 'diff', '--src-prefix=a/', '--dst-prefix=b/', 'main...feature')}\n`)
    fs.writeFileSync(path.join(runDir, 'head.txt'), git(repoDir, 'rev-parse', 'HEAD'))
    const result = runScript('node', [PRECHECK, runDir, '--repo', repoDir])
    assert.equal(result.status, 0, result.stderr)
    const findings = JSON.parse(readText(path.join(runDir, 'precheck.json')))
    assert.deepEqual(findings.map(finding => finding.check), ['unchecked-field'])
    assert.deepEqual(JSON.parse(result.stdout).byCheck, { 'unchecked-field': 1 })
  })

  test('writes no findings under a variant that runs without prechecks, and says so', () => {
    const repoDir = fixtureRepo({}, { 'src/merge.js': lines("export const key = finding => finding.duplicates?.split(':')[0]") })
    const runDir = makeTempDir('precheck-run')
    fs.writeFileSync(path.join(runDir, 'diff.patch'), `${git(repoDir, 'diff', '--src-prefix=a/', '--dst-prefix=b/', 'main...feature')}\n`)
    const result = runScript('node', [PRECHECK, runDir, '--repo', repoDir], { env: { ...process.env, LENS_REVIEW_VARIANT: 'a' } })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readText(path.join(runDir, 'precheck.json'))), [])
    assert.equal(JSON.parse(result.stdout).skipped, 'variant a runs without prechecks')
  })

  test('fails naming the run dir when it holds no diff.patch', () => {
    const result = runScript('node', [PRECHECK, makeTempDir('precheck-empty')])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /lens-review: .*diff\.patch/)
  })

  test('fails with usage when no run dir is given', () => {
    const result = runScript('node', [PRECHECK])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /usage/)
  })
})

// The PR's head rebuilt offline: lens-review #3 is its base commit (on main) plus change.patch;
// carpool #13 is the files the PR adds (from change.patch) plus the migrations already merged.
function goldRunDir(caseName, repoDir) {
  const runDir = makeTempDir(`precheck-${caseName}`)
  fs.copyFileSync(path.join(EVAL_DIR, caseName, 'change.patch'), path.join(runDir, 'diff.patch'))
  fs.writeFileSync(path.join(runDir, 'head.txt'), git(repoDir, 'rev-parse', 'HEAD'))
  return runDir
}

function commitAll(repoDir) {
  git(repoDir, 'add', '-A')
  git(repoDir, '-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', 'commit', '-q', '-m', 'head')
}

function buildPr3Head() {
  const repoDir = makeTempDir('pr3-head')
  const base = readText(path.join(EVAL_DIR, 'lens-review-pr3', 'base.txt')).trim()
  const archive = runScript('git', ['-C', REPO_ROOT, 'archive', '--format=tar', base], { encoding: 'buffer', maxBuffer: ARCHIVE_MAX_BYTES })
  if (archive.status !== 0) return null
  runScript('tar', ['-x', '-C', repoDir], { input: archive.stdout, encoding: 'buffer' })
  git(repoDir, 'init', '-q')
  git(repoDir, 'apply', path.join(EVAL_DIR, 'lens-review-pr3', 'change.patch'))
  commitAll(repoDir)
  return repoDir
}

function buildCarpoolHead() {
  const repoDir = makeTempDir('carpool-head')
  git(repoDir, 'init', '-q')
  const newFiles = parseDiffFiles(readText(path.join(EVAL_DIR, 'carpool-pr13', 'change.patch'))).filter(file => file.isNew)
  writeFiles(repoDir, Object.fromEntries(newFiles.map(file => [file.path, lines(...file.added.map(({ text }) => text))])))
  const merged = JSON.parse(readText(path.join(EVAL_DIR, 'carpool-pr13', 'merged-migrations.json')))
  writeFiles(repoDir, Object.fromEntries(merged.map(migration => [migration, '-- merged before this PR\n'])))
  commitAll(repoDir)
  return repoDir
}

describe('prechecks on the real-PR answer keys', () => {
  const cases = [
    {
      caseName: 'lens-review-pr3',
      buildHead: buildPr3Head,
      expected: { 'duplicate-in-diff': 'P10', 'newly-unused': 'P11', 'untested-failure-path': 'P15', 'unchecked-field': 'P7' },
      expectedCounts: { 'duplicate-in-diff': 1, 'newly-unused': 1, 'untested-failure-path': 1, 'unchecked-field': 1 },
    },
    {
      caseName: 'carpool-pr13',
      buildHead: buildCarpoolHead,
      expected: { 'untested-failure-path': 'K5', 'migration-order': 'K3' },
      // The three copies of the e2e pick-child helpers (K12): the merge folds them into one finding.
      expectedCounts: { 'untested-failure-path': 1, 'migration-order': 1, 'duplicate-in-diff': 3 },
    },
  ]
  for (const { caseName, buildHead, expected, expectedCounts } of cases) {
    describe(caseName, () => {
      let findings
      let elapsedMs
      let skipReason = null

      before(() => {
        const repoDir = buildHead()
        if (!repoDir) {
          skipReason = 'the base commit is not in this clone (shallow?)'
          return
        }
        const runDir = goldRunDir(caseName, repoDir)
        const startedAt = Date.now()
        const result = runScript('node', [PRECHECK, runDir, '--repo', repoDir])
        elapsedMs = Date.now() - startedAt
        assert.equal(result.status, 0, result.stderr)
        findings = JSON.parse(readText(path.join(runDir, 'precheck.json'))).map((finding, index) => ({ ...finding, id: `C${index + 1}` }))
      })

      test('each check fires on the gold issue it was built for', t => {
        if (skipReason) return t.skip(skipReason)
        const gold = JSON.parse(readText(path.join(EVAL_DIR, caseName, 'gold.json')))
        for (const [check, issueId] of Object.entries(expected)) {
          const fromCheck = findings.filter(finding => finding.check === check)
          const { caught } = scoreRecall({ issues: gold.issues.filter(issue => issue.id === issueId) }, fromCheck)
          assert.ok(caught[issueId], `${check} did not catch ${issueId}: ${JSON.stringify(fromCheck)}`)
        }
      })

      test('fires once per gold issue at most, on the issues it was built for', t => {
        if (skipReason) return t.skip(skipReason)
        const counts = {}
        for (const { check } of findings) counts[check] = (counts[check] ?? 0) + 1
        assert.deepEqual(counts, expectedCounts)
      })

      test('no precheck finding is a false positive', t => {
        if (skipReason) return t.skip(skipReason)
        const gold = JSON.parse(readText(path.join(EVAL_DIR, caseName, 'gold.json')))
        const { unmatched } = scoreRecall(gold, findings)
        assert.deepEqual(
          findings.filter(finding => unmatched.includes(finding.id)),
          [],
        )
      })

      test('runs in under 5 s', t => {
        if (skipReason) return t.skip(skipReason)
        assert.ok(elapsedMs < PRECHECK_TIME_LIMIT_MS, `took ${elapsedMs} ms`)
      })
    })
  }
})
