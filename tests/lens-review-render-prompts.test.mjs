import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SCRIPTS_DIR, SKILL_DIR, makeTempDir, readText, runScript, writeFiles } from './helpers.mjs'

const RENDER_PROMPTS = path.join(SCRIPTS_DIR, 'render-prompts.mjs')
// A placeholder left in a rendered prompt reaches the agent as literal text.
const UNFILLED_RE = /<<<[A-Z_]+>>>|<RUN_DIR>/

const PERSONA = name => `# ${name}\n\nScope:\n- **\n\nRules:\n- [should] A rule.\n- Do not flag style.\n`

describe('render-prompts.mjs', () => {
  let runDir
  let teamDir

  function writeRunInputs({ planDocs = { passed: [], fromPr: [] } } = {}) {
    writeFiles(runDir, {
      'pr-context.txt': 'Add standing drives\n\nFills each week from a fixed rota.\n',
      'rule-sources.json': JSON.stringify([{ path: 'AGENTS.md', kind: 'agents' }]),
      'plan-docs.json': JSON.stringify(planDocs),
      'panel.json': JSON.stringify({
        panel: 'Panel: core ×2 + The Data Steward (db/x.sql)',
        selected: [
          { file: 'maintainer.md', name: 'The Maintainer', matchedBy: [] },
          { file: 'domain-expert.md', name: 'The Domain Expert', matchedBy: [] },
          { file: 'data-steward.md', name: 'The Data Steward', matchedBy: ['db/x.sql'] },
        ],
        uncoveredFiles: [],
      }),
      'merged.json': JSON.stringify([{ id: 'F1', file: 'db/x.sql', line: 3 }]),
      'tallied.json': JSON.stringify([{ id: 'F1', file: 'db/x.sql', line: 3, contested: false }]),
    })
  }

  function render(...args) {
    return runScript('node', [RENDER_PROMPTS, runDir, teamDir, ...args])
  }

  function prompt(name) {
    return readText(path.join(runDir, `prompt-${name}.txt`))
  }

  beforeEach(() => {
    runDir = makeTempDir('render-run')
    teamDir = makeTempDir('render-team')
    writeFiles(teamDir, {
      'maintainer.md': PERSONA('The Maintainer'),
      'domain-expert.md': PERSONA('The Domain Expert'),
      'data-steward.md': PERSONA('The Data Steward'),
    })
    writeRunInputs()
  })

  test('review: writes one full prompt per reviewer and prints one line per agent to spawn', () => {
    const result = render()
    assert.equal(result.status, 0, result.stderr)
    const { agents, collectArgs } = JSON.parse(result.stdout)
    assert.deepEqual(
      agents.map(({ stem, reviewer }) => [stem, reviewer]),
      [['anthropic', 'Anthropic'], ['deep-pass', 'Deep Pass'], ['maintainer', 'The Maintainer'], ['domain-expert', 'The Domain Expert'], ['data-steward', 'The Data Steward']],
    )
    for (const agent of agents) {
      assert.equal(agent.promptPath, path.join(runDir, `prompt-${agent.stem}.txt`))
      assert.equal(agent.model, agent.stem === 'deep-pass' ? 'sonnet' : 'haiku')
      assert.doesNotMatch(prompt(agent.stem), UNFILLED_RE, `${agent.stem} has an unfilled placeholder`)
      assert.ok(prompt(agent.stem).includes(path.join(runDir, `reply-${agent.stem}.txt`)))
    }
    assert.deepEqual(collectArgs, ['anthropic=Anthropic', 'deep-pass=Deep Pass', 'maintainer=The Maintainer', 'domain-expert=The Domain Expert', 'data-steward=The Data Steward'])
  })

  test('review: fills the persona file, the PR context, the rule paths and the categories', () => {
    render()
    const maintainer = prompt('maintainer')
    assert.ok(maintainer.includes(PERSONA('The Maintainer').trim()))
    assert.ok(maintainer.includes('Add standing drives'))
    assert.ok(maintainer.includes('AGENTS.md'))
    assert.match(maintainer, /category \(one of: security, correctness, .*, tests\)/)
    assert.ok(maintainer.includes(readText(path.join(SKILL_DIR, 'checklist.md')).trim()), 'the Maintainer gets the checklist')
    assert.ok(!prompt('domain-expert').includes(readText(path.join(SKILL_DIR, 'checklist.md')).trim()))
  })

  test('review: placeholder-looking text inside a value (a PR about this skill) reaches the agent as written', () => {
    fs.writeFileSync(path.join(runDir, 'pr-context.txt'), 'Fill <<<REPLY_FILE>>> under <RUN_DIR>, costs $1 and $&\n')
    const result = render()
    assert.equal(result.status, 0, result.stderr)
    assert.ok(prompt('maintainer').includes('Fill <<<REPLY_FILE>>> under <RUN_DIR>, costs $1 and $&'))
  })

  test('review: a scoped persona reads only the hunks its Scope or Signals matched', () => {
    render()
    assert.ok(prompt('data-steward').includes('(these: db/x.sql)'))
    assert.ok(!prompt('maintainer').includes('(these:'))
  })

  test('review: only the Domain Expert and the Data Steward get the plan docs, the PR\'s own marked unverified', () => {
    writeRunInputs({ planDocs: { passed: ['/plans/tech-design.md'], fromPr: ['docs/plan-x.md'] } })
    render()
    for (const stem of ['domain-expert', 'data-steward']) {
      assert.match(prompt(stem), /\/plans\/tech-design\.md \(passed by the caller\)/)
      assert.match(prompt(stem), /docs\/plan-x\.md \(added in this PR, unverified\)/)
    }
    assert.ok(!prompt('maintainer').includes('PLAN DOCS'))
  })

  test('review: no plan note at all when there are no plan docs', () => {
    render()
    assert.ok(!prompt('domain-expert').includes('PLAN DOCS'))
  })

  test('challenge: writes each persona\'s ballot prompt with the merged findings', () => {
    const result = render('--phase', 'challenge')
    assert.equal(result.status, 0, result.stderr)
    const { voters } = JSON.parse(result.stdout)
    assert.deepEqual(voters.map(voter => voter.stem), ['maintainer', 'domain-expert', 'data-steward'])
    const ballot = prompt('votes-maintainer')
    assert.doesNotMatch(ballot, UNFILLED_RE)
    assert.ok(ballot.includes('"F1"'))
    assert.ok(ballot.includes(path.join(runDir, 'reply-votes-maintainer.txt')))
  })

  test('skeptic: only the passed plan docs are approved; the PR\'s own are unverified', () => {
    writeRunInputs({ planDocs: { passed: ['/plans/tech-design.md'], fromPr: ['docs/plan-x.md'] } })
    const result = render('--phase', 'skeptic')
    assert.equal(result.status, 0, result.stderr)
    const skeptic = prompt('skeptic')
    assert.doesNotMatch(skeptic, UNFILLED_RE)
    const approved = skeptic.slice(skeptic.indexOf('APPROVED PLAN DOCS'), skeptic.indexOf('UNVERIFIED PLAN DOCS'))
    assert.ok(approved.includes('/plans/tech-design.md'))
    assert.ok(!approved.includes('docs/plan-x.md'), 'a PR-added plan doc reached the approved list')
    assert.ok(skeptic.includes('"contested": false'))
    assert.equal(JSON.parse(result.stdout).model, 'opus')
  })

  test('skeptic: "none" stands in for an empty plan list', () => {
    render('--phase', 'skeptic')
    assert.match(prompt('skeptic'), /APPROVED PLAN DOCS[^\n]*\nnone\n/)
  })

  test('fails naming a run input that is missing, and writes no prompt', () => {
    fs.rmSync(path.join(runDir, 'panel.json'))
    const result = render()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /lens-review: .*panel\.json/)
    assert.ok(!fs.existsSync(path.join(runDir, 'prompt-anthropic.txt')))
  })

  test('fails naming a selected persona whose file is not in the team dir', () => {
    fs.rmSync(path.join(teamDir, 'data-steward.md'))
    const result = render()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /data-steward\.md/)
  })

  test('fails on an unknown phase, and with usage when the dirs are missing', () => {
    assert.match(render('--phase', 'nope').stderr, /unknown phase "nope"/)
    const noDirs = runScript('node', [RENDER_PROMPTS])
    assert.notEqual(noDirs.status, 0)
    assert.match(noDirs.stderr, /usage/)
  })
})

describe('the A/B variants (LENS_REVIEW_VARIANT)', () => {
  let runDir
  let teamDir

  beforeEach(() => {
    runDir = makeTempDir('variant-run')
    teamDir = makeTempDir('variant-team')
    writeFiles(teamDir, { 'maintainer.md': PERSONA('The Maintainer') })
    writeFiles(runDir, {
      'pr-context.txt': 'A change\n',
      'rule-sources.json': '[]',
      'plan-docs.json': JSON.stringify({ passed: [], fromPr: [] }),
      'panel.json': JSON.stringify({ selected: [{ file: 'maintainer.md', name: 'The Maintainer', matchedBy: [] }] }),
    })
  })

  const renderAs = variant =>
    runScript('node', [RENDER_PROMPTS, runDir, teamDir], { env: { ...process.env, LENS_REVIEW_VARIANT: variant } })

  test('a: every reviewer on Haiku, with the challenge round', () => {
    const { agents, challengeRound } = JSON.parse(renderAs('a').stdout)
    assert.ok(agents.every(agent => agent.model === 'haiku'))
    assert.equal(challengeRound, true)
  })

  test('b: the Anthropic-general reviewer on Sonnet, the rest as a', () => {
    const { agents, challengeRound } = JSON.parse(renderAs('b').stdout)
    assert.equal(agents.find(agent => agent.stem === 'anthropic').model, 'sonnet')
    assert.equal(agents.find(agent => agent.stem === 'maintainer').model, 'haiku')
    assert.equal(challengeRound, true)
  })

  test('c: no challenge round, and one Sonnet deep-pass reviewer on the whole diff', () => {
    const result = renderAs('c')
    assert.equal(result.status, 0, result.stderr)
    const { agents, challengeRound, collectArgs } = JSON.parse(result.stdout)
    assert.equal(challengeRound, false)
    const deepPass = agents.find(agent => agent.stem === 'deep-pass')
    assert.equal(deepPass.model, 'sonnet')
    assert.ok(collectArgs.includes('deep-pass=Deep Pass'))
    assert.doesNotMatch(readText(deepPass.promptPath), UNFILLED_RE)
  })

  test('d, the default: c (the A/B winner) plus prechecks', () => {
    for (const variant of ['d', '']) {
      const { agents, challengeRound } = JSON.parse(renderAs(variant).stdout)
      assert.equal(challengeRound, false)
      assert.equal(agents.find(agent => agent.stem === 'deep-pass').model, 'sonnet')
    }
  })

  test('an unknown variant fails naming it, rather than silently running the default', () => {
    const result = renderAs('z')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /LENS_REVIEW_VARIANT "z"/)
  })
})
