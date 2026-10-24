import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, makeTempDir, readText, runScript } from './helpers.mjs'
import { parseDiffLines, isLineInDiff } from '../skills/lens-review/scripts/merge-findings.mjs'

const EVAL_DIR = path.join(REPO_ROOT, 'tests', 'lens-review-eval')
const SCORE_RECALL = path.join(EVAL_DIR, 'score-recall.mjs')
// The real-PR answer keys: each holds change.patch, gold.json and runs/<run>.json.
const GOLD_CASES = ['carpool-pr13', 'lens-review-pr3']
// The carpool patch is stored with every Hebrew word replaced by this one placeholder, so no
// name, relation or rota from the real PR can reach the repo.
const HEBREW_PLACEHOLDER = 'שם'

function finding(id, overrides = {}) {
  return { id, file: 'src/a.ts', line: 10, severity: 'should', category: 'correctness', ...overrides }
}

function goldIssue(id, overrides = {}) {
  return { id, file: 'src/a.ts', line_range: [9, 12], category: 'correctness', severity: 'should', summary: id, ...overrides }
}

function readGold(caseName) {
  return JSON.parse(readText(path.join(EVAL_DIR, caseName, 'gold.json')))
}

describe('lens-review-eval/score-recall.mjs', () => {
  let scoreRecall

  beforeEach(async () => {
    ;({ scoreRecall } = await import(SCORE_RECALL))
  })

  test('reports recall, precision and must-level recall against the gold issues', () => {
    const gold = {
      issues: [
        goldIssue('G1', { severity: 'must' }),
        goldIssue('G2', { file: 'src/b.ts' }),
        goldIssue('G3', { file: 'src/c.ts', severity: 'must' }),
      ],
    }
    const score = scoreRecall(gold, [finding('F1'), finding('F2', { file: 'src/b.ts' }), finding('F3', { file: 'src/z.ts' })])
    assert.deepEqual(score.recall, { caught: 2, total: 3 })
    assert.deepEqual(score.precision, { matched: 2, kept: 3 })
    assert.deepEqual(score.mustRecall, { caught: 1, total: 2 })
    assert.deepEqual(score.missed, ['G3'])
    assert.deepEqual(score.unmatched, ['F3'])
    assert.equal(score.duplicates, 0)
  })

  test('a finding in the right place with the wrong category does not count', () => {
    const score = scoreRecall({ issues: [goldIssue('G1')] }, [finding('F1', { category: 'performance' })])
    assert.deepEqual(score.recall, { caught: 0, total: 1 })
    assert.deepEqual(score.unmatched, ['F1'])
  })

  test('a second finding on an issue already caught counts as a duplicate, not a false positive', () => {
    const score = scoreRecall({ issues: [goldIssue('G1')] }, [finding('F1'), finding('F2', { line: 12 })])
    assert.equal(score.duplicates, 1)
    assert.deepEqual(score.precision, { matched: 2, kept: 2 })
    assert.deepEqual(score.recall, { caught: 1, total: 1 })
  })

  test('an alternate location or category of a gold issue counts as catching it', () => {
    const gold = {
      issues: [goldIssue('G1', { alternates: [{ file: 'src/other.ts', line_range: [1, 3], category: 'security' }] })],
    }
    assert.deepEqual(scoreRecall(gold, [finding('F1', { file: 'src/other.ts', line: 2, category: 'security' })]).recall, {
      caught: 1,
      total: 1,
    })
    assert.deepEqual(scoreRecall(gold, [finding('F1', { file: 'src/other.ts', line: 2 })]).recall, { caught: 0, total: 1 })
  })

  test('a merged finding catches an issue at any of the copies it lists', () => {
    const gold = { issues: [goldIssue('G1', { file: 'src/copy.ts', category: 'duplication' })] }
    const mergedCopies = finding('F1', {
      file: 'src/first.ts',
      category: 'duplication',
      locations: [
        { file: 'src/first.ts', line: 3 },
        { file: 'src/copy.ts', line: 10 },
      ],
    })
    assert.deepEqual(scoreRecall(gold, [mergedCopies]).recall, { caught: 1, total: 1 })
  })

  test('one finding never catches two issues, and two issues are never charged as a duplicate', () => {
    // F1 fits both issues; F2 fits only G1. The best pairing catches both and wastes nothing.
    const gold = {
      issues: [goldIssue('G1'), goldIssue('G2', { alternates: [{ file: 'src/a.ts', line_range: [10, 10], category: 'correctness' }] })],
    }
    const bothFit = scoreRecall(gold, [finding('F1'), finding('F2', { line: 9 })])
    assert.deepEqual(bothFit.recall, { caught: 2, total: 2 })
    assert.equal(bothFit.duplicates, 0)
    const oneFinding = scoreRecall(gold, [finding('F1')])
    assert.deepEqual(oneFinding.recall, { caught: 1, total: 2 })
  })

  test('a finding that fits a narrow issue and a broad one is credited to the narrow one', () => {
    const gold = {
      issues: [
        goldIssue('BROAD', { file: 'src/b.ts', alternates: [{ file: 'src/a.ts', line_range: [1, 99], category: 'correctness' }] }),
        goldIssue('NARROW', { line_range: [10, 11] }),
      ],
    }
    const score = scoreRecall(gold, [finding('F1')])
    assert.deepEqual(score.caught, { NARROW: 'F1' })
    assert.deepEqual(score.missed, ['BROAD'])
  })

  test('an empty review catches nothing and has no precision to report', () => {
    const score = scoreRecall({ issues: [goldIssue('G1')] }, [])
    assert.deepEqual(score.recall, { caught: 0, total: 1 })
    assert.deepEqual(score.precision, { matched: 0, kept: 0 })
  })

  test('refuses a gold file without an issues array', () => {
    assert.throws(() => scoreRecall({ must_catch: [] }, []), /issues/)
  })

  test('refuses a gold issue with no id or no line range', () => {
    assert.throws(() => scoreRecall({ issues: [{ file: 'src/a.ts', category: 'tests' }] }, []), /line_range/)
  })

  test('CLI prints one score per findings file, keyed by its name', () => {
    const inputDir = makeTempDir('recall-input')
    const goldPath = path.join(inputDir, 'gold.json')
    fs.writeFileSync(goldPath, JSON.stringify({ issues: [goldIssue('G1')] }))
    fs.writeFileSync(path.join(inputDir, 'caught.json'), JSON.stringify([finding('F1')]))
    fs.writeFileSync(path.join(inputDir, 'missed.json'), '[]')
    const result = runScript('node', [
      SCORE_RECALL,
      '--gold',
      goldPath,
      path.join(inputDir, 'caught.json'),
      path.join(inputDir, 'missed.json'),
    ])
    assert.equal(result.status, 0, result.stderr)
    const scores = JSON.parse(result.stdout)
    assert.deepEqual(scores.caught.recall, { caught: 1, total: 1 })
    assert.deepEqual(scores.missed.recall, { caught: 0, total: 1 })
  })

  test('CLI exits non-zero naming a findings file that is not a JSON array', () => {
    const inputDir = makeTempDir('recall-input')
    const goldPath = path.join(inputDir, 'gold.json')
    fs.writeFileSync(goldPath, JSON.stringify({ issues: [goldIssue('G1')] }))
    const badPath = path.join(inputDir, 'bad.json')
    fs.writeFileSync(badPath, '{"not": "an array"}')
    const result = runScript('node', [SCORE_RECALL, '--gold', goldPath, badPath])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /bad\.json/)
  })

  test('CLI exits non-zero with usage when --gold or the findings files are missing', () => {
    const result = runScript('node', [SCORE_RECALL])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /usage/)
  })
})

describe('real-PR answer keys', () => {
  for (const caseName of GOLD_CASES) {
    test(`${caseName}: every gold issue points at a line its change.patch changes`, () => {
      const diffLines = parseDiffLines(readText(path.join(EVAL_DIR, caseName, 'change.patch')))
      for (const issue of readGold(caseName).issues) {
        for (const spot of [issue, ...(issue.alternates ?? [])]) {
          const [first, last] = spot.line_range
          const touchesDiff = Array.from({ length: last - first + 1 }, (_, offset) => first + offset).some(line =>
            isLineInDiff(diffLines, spot.file, line),
          )
          assert.ok(touchesDiff, `${issue.id} cites ${spot.file}:${first}-${last}, which the diff does not change`)
        }
      }
    })

    test(`${caseName}: gold ids are unique and every issue has a severity and a summary`, () => {
      const { issues } = readGold(caseName)
      assert.equal(new Set(issues.map(issue => issue.id)).size, issues.length)
      for (const issue of issues) {
        assert.ok(['must', 'should', 'suggestion'].includes(issue.severity), `${issue.id} has severity ${issue.severity}`)
        assert.ok(issue.summary, `${issue.id} has no summary`)
      }
    })
  }

  test('carpool-pr13: the stored patch carries no Hebrew word but the placeholder', () => {
    const hebrewWords = readText(path.join(EVAL_DIR, 'carpool-pr13', 'change.patch')).match(/[֐-׿]+/g) ?? []
    assert.deepEqual([...new Set(hebrewWords)], [HEBREW_PLACEHOLDER])
  })

  test('the stored runs score as the baseline in RESULT.md', async () => {
    const { scoreRecall } = await import(SCORE_RECALL)
    const baseline = {
      'carpool-pr13/old-lens': { recall: 7, precision: [12, 15], duplicates: 5, must: 1 },
      'carpool-pr13/new-lens': { recall: 6, precision: [6, 6], duplicates: 0, must: 0 },
      'carpool-pr13/single-agent': { recall: 7, precision: [8, 8], duplicates: 1, must: 1 },
      'lens-review-pr3/lens': { recall: 12, precision: [13, 15], duplicates: 1, must: 1 },
      'lens-review-pr3/t2a': { recall: 13, precision: [15, 17], duplicates: 2, must: 0 },
    }
    for (const [run, expected] of Object.entries(baseline)) {
      const [caseName, runName] = run.split('/')
      const findings = JSON.parse(readText(path.join(EVAL_DIR, caseName, 'runs', `${runName}.json`)))
      const score = scoreRecall(readGold(caseName), findings)
      assert.equal(score.recall.caught, expected.recall, `${run} recall`)
      assert.deepEqual([score.precision.matched, score.precision.kept], expected.precision, `${run} precision`)
      assert.equal(score.duplicates, expected.duplicates, `${run} duplicates`)
      assert.equal(score.mustRecall.caught, expected.must, `${run} must-level recall`)
    }
  })
})
