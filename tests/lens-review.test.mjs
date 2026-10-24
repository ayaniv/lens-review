import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  REPO_ROOT,
  SCRIPTS_DIR,
  SKILL_DIR,
  SKILL_NAME,
  git,
  makeTempDir,
  parseFrontmatter,
  readText,
  runScript,
} from './helpers.mjs'

const TEAM_DIR = path.join(SKILL_DIR, 'team')
const CASTING_PROMPT = path.join(SKILL_DIR, 'casting-prompt.md')
const VALIDATE_TEAM = path.join(SCRIPTS_DIR, 'validate-team.mjs')
const CHALLENGE_PROMPT = path.join(SKILL_DIR, 'challenge-prompt.md')
const GENERAL_PROMPT = path.join(SKILL_DIR, 'reviewer-general-prompt.md')
const PERSONA_PROMPT = path.join(SKILL_DIR, 'reviewer-persona-prompt.md')
const SKEPTIC_PROMPT = path.join(SKILL_DIR, 'skeptic-prompt.md')
const TALLY_CHALLENGES = path.join(SCRIPTS_DIR, 'tally-challenges.mjs')
// The eval is a test fixture, not part of the shipped skill.
const EVAL_DIR = path.join(REPO_ROOT, 'tests', 'lens-review-eval')
const SCORE_REVIEW = path.join(EVAL_DIR, 'score-review.mjs')
const SEEDED_PR_DIR = path.join(EVAL_DIR, 'seeded-pr')
const MERGE_FINDINGS = path.join(SCRIPTS_DIR, 'merge-findings.mjs')
const BUILD_PR_REVIEW = path.join(SCRIPTS_DIR, 'build-pr-review.mjs')

const CORE_PERSONAS = {
  'architect.md': 'The Architect',
  'maintainer.md': 'The Maintainer',
  'reliability-engineer.md': 'The Reliability Engineer',
  'domain-expert.md': 'The Domain Expert',
  'reuse-scout.md': 'The Reuse Scout',
}
// Area personas join a review only when a changed file is in their Scope, so none may be `**`.
const AREA_PERSONAS = {
  'backend-reviewer.md': 'The Backend Reviewer',
  'design-system-guardian.md': 'The Design System Guardian',
  'data-steward.md': 'The Data Steward',
  'infra-reviewer.md': 'The Infra Reviewer',
}
const LIVE_EVAL_TIMEOUT_MS = 15 * 60 * 1000
const SCRIPT_REFERENCE_RE = /scripts\/([\w./-]+\.(?:sh|mjs))/g

function merged(id, reviewers, overrides = {}) {
  return {
    id,
    file: 'src/api.ts',
    line: 10,
    severity: 'should',
    category: 'correctness',
    description: 'Missing await',
    rule: 'Await async calls',
    reviewers,
    ...overrides,
  }
}

function readExpected() {
  return JSON.parse(readText(path.join(SEEDED_PR_DIR, 'expected.json')))
}

// Rebuilds the seeded PR as a real repo: base/ committed on main, change.patch applied on a branch.
function buildSeededRepo() {
  const repoDir = makeTempDir('seeded-pr')
  fs.cpSync(path.join(SEEDED_PR_DIR, 'base'), repoDir, { recursive: true })
  git(repoDir, 'init', '-q', '-b', 'main')
  git(repoDir, 'config', 'user.email', 'fixture@example.com')
  git(repoDir, 'config', 'user.name', 'Fixture')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-q', '-m', 'base')
  git(repoDir, 'checkout', '-q', '-b', 'seeded-change')
  git(repoDir, 'apply', path.join(SEEDED_PR_DIR, 'change.patch'))
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-q', '-m', 'seeded change')
  return repoDir
}

describe('skill layout', () => {
  test('SKILL.md frontmatter names the skill and allows agents + the challenge follow-up', () => {
    const frontmatter = parseFrontmatter(readText(path.join(SKILL_DIR, 'SKILL.md')))
    assert.equal(frontmatter.name, SKILL_NAME)
    assert.ok(frontmatter.description.length > 0)
    for (const tool of ['Agent', 'SendMessage', 'ToolSearch', 'Bash', 'Read', 'Write']) {
      assert.ok(frontmatter['allowed-tools'].includes(tool), `allowed-tools is missing ${tool}`)
    }
  })

  test('drives its own scripts and prompts', () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    for (const ownPiece of [
      'scripts/gather-diff.sh',
      'scripts/discover-rule-sources.mjs',
      'scripts/merge-findings.mjs',
      'scripts/parse-reply.mjs',
      'scripts/tally-challenges.mjs',
      'scripts/team-dir.mjs',
      'scripts/validate-team.mjs',
      'scripts/select-team.mjs',
      'scripts/build-pr-review.mjs',
      'scripts/collect-findings.mjs',
      'scripts/collect-votes.mjs',
      'scripts/apply-skeptic.mjs',
      'scripts/discover-plan-docs.mjs',
      'scripts/precheck.mjs',
      'scripts/render-prompts.mjs',
      'reviewer-general-prompt.md',
      'reviewer-persona-prompt.md',
      'skeptic-prompt.md',
      'checklist.md',
      'casting-prompt.md',
      'challenge-prompt.md',
    ]) {
      assert.ok(skill.includes(ownPiece), `SKILL.md does not reference ${ownPiece}`)
      assert.ok(fs.existsSync(path.join(SKILL_DIR, ownPiece)), `missing ${ownPiece}`)
    }
  })

  test('ships no eval fixture inside the skill folder', () => {
    assert.ok(!fs.existsSync(path.join(SKILL_DIR, 'eval')))
  })

  test('the skill folder name matches its frontmatter name, so a symlink installs it under the right name', () => {
    assert.equal(path.basename(SKILL_DIR), parseFrontmatter(readText(path.join(SKILL_DIR, 'SKILL.md'))).name)
  })

  test('every scripts/ path SKILL.md references exists inside the skill', () => {
    const referencedPaths = [...readText(path.join(SKILL_DIR, 'SKILL.md')).matchAll(SCRIPT_REFERENCE_RE)].map(
      match => match[1],
    )
    assert.ok(referencedPaths.length > 0, 'SKILL.md references no scripts/ paths')
    for (const referencedPath of referencedPaths) {
      assert.ok(fs.existsSync(path.join(SCRIPTS_DIR, referencedPath)), `missing scripts/${referencedPath}`)
    }
  })

  test('the dedup line window lives only in merge-findings.mjs; no prompt restates the number', async () => {
    const { DEDUP_LINE_WINDOW } = await import(MERGE_FINDINGS)
    assert.equal(DEDUP_LINE_WINDOW, 3)
    for (const entry of fs.readdirSync(SKILL_DIR, { recursive: true })) {
      const filePath = path.join(SKILL_DIR, entry)
      if (!filePath.endsWith('.md') || !fs.statSync(filePath).isFile()) continue
      assert.doesNotMatch(readText(filePath), /±\s*3\b/, `${entry} restates the dedup window`)
    }
  })

  test('every agent writes its own reply file, with no code fence, and every reply goes through parse-reply.mjs', () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    const prompts = [
      ['SKILL.md', skill, 0],
      ['casting-prompt.md', readText(CASTING_PROMPT), 1],
      ['challenge-prompt.md', readText(CHALLENGE_PROMPT), 1],
      ['reviewer-general-prompt.md', readText(GENERAL_PROMPT), 1],
      ['reviewer-persona-prompt.md', readText(PERSONA_PROMPT), 1],
      ['skeptic-prompt.md', readText(SKEPTIC_PROMPT), 1],
    ]
    for (const [name, text, agentCount] of prompts) {
      assert.doesNotMatch(text, /^Return ONLY/m, `${name}: an agent still hands its JSON back in its message`)
      const writeLines = text.match(/^Write ONLY.*$/gm) ?? []
      assert.equal(writeLines.length, agentCount, `${name}: expected ${agentCount} reply instructions`)
      for (const writeLine of writeLines) {
        assert.match(writeLine, /to <<<REPLY_FILE>>> with the Write tool, no other text and no code fence/, `${name}: "${writeLine}"`)
      }
    }
    assert.match(skill, /never copy a reply out of an agent's message or transcript/)
    assert.match(skill, /parse-reply\.mjs" "<RUN_DIR>\/reply-cast\.txt" "<RUN_DIR>\/cast\.json"/, 'cast.json is not written by parse-reply.mjs')
  })

  test('launches every agent with a one-line prompt pointing at the prompt file a script rendered', () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    for (const phase of ['"<TEAM_DIR>"\n', '"<TEAM_DIR>" --phase challenge', '"<TEAM_DIR>" --phase skeptic']) {
      assert.ok(skill.includes(`scripts/render-prompts.mjs" "<RUN_DIR>" ${phase}`), `no render-prompts call for ${phase.trim()}`)
    }
    assert.match(skill, /^Read <promptPath> and follow it exactly\.$/m)
    // Casting runs once per repo and is still filled by hand; every per-run prompt is rendered.
    assert.doesNotMatch(skill, /<<<(PERSONA_FILE|CATEGORIES|PLAN_NOTE|SCOPE_NOTE|MERGED_FINDINGS|TALLIED_FINDINGS_JSON|APPROVED_PLAN_DOCS)>>>/)
  })

  test('clocks every phase into timings.json and prints the Timing line', () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    for (const phase of ['gather', 'review', 'challenge', 'skeptic']) {
      for (const event of ['start', 'end']) {
        assert.ok(skill.includes(`phase-clock.mjs" "<RUN_DIR>" ${phase} ${event}`), `no clock for ${phase} ${event}`)
      }
    }
    assert.match(skill, /phase-clock\.mjs" "<RUN_DIR>" --summary/)
    assert.match(skill, /^Timing: /m)
  })

  test('skips the challenge round when the variant has none, keeping the Challenge round: line', () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    const challengeStep = skill.slice(skill.indexOf('## Step 3'), skill.indexOf('## Step 4'))
    assert.match(challengeStep, /`challengeRound` is `false`/)
    assert.match(challengeStep, /Challenge round: skipped \(variant <name>\)/)
  })

  test('runs each phase\'s deterministic tail as one script call, never by hand', () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    assert.match(skill, /scripts\/collect-findings\.mjs" "<RUN_DIR>" "anthropic=Anthropic"/)
    assert.match(skill, /scripts\/collect-votes\.mjs" "<RUN_DIR>"/)
    assert.match(skill, /scripts\/apply-skeptic\.mjs" "<RUN_DIR>"/)
    assert.doesNotMatch(skill, /final-findings\.json` with `Write`/, 'final-findings.json must come from a script')
  })

  // No persona or repo rule asked for this, and 13 live carpool runs missed the must-level
  // case of it: real-looking people, relations and schedules in an e2e spec.
  test('the checklist and the deep pass both look for real people\'s details committed to the repo', () => {
    const rule = /real people's personal details/i
    assert.match(readText(path.join(SKILL_DIR, 'checklist.md')), rule)
    assert.match(readText(path.join(SKILL_DIR, 'reviewer-deep-pass-prompt.md')), rule)
  })

  // A live carpool run lost its whole review to a skeptic that skipped 2 of 23 ids.
  test('asks the skeptic once for the ids it left unruled before stopping', () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    const skepticStep = skill.slice(skill.indexOf('## Step 4'), skill.indexOf('## Step 5'))
    assert.match(skepticStep, /`SendMessage` the same skeptic once/)
    assert.match(skepticStep, /If it still leaves one unruled, \*\*stop\*\*/)
  })

  test("the skeptic rules on each finding's own merits and never drops one for repeating another", () => {
    assert.match(readText(SKEPTIC_PROMPT), /Never drop a finding because another finding repeats it/)
  })

  describe('skeptic check 4: which plan can justify a drop', () => {
    // render-prompts.mjs fills the lists; its own tests prove a PR-added doc never reaches the approved one.
    const skeptic = () => {
      const prompt = readText(SKEPTIC_PROMPT)
      const dropCheck = prompt.split('\n').find(line => /^4\. /.test(line))
      return { prompt, dropCheck }
    }

    test('only the plan docs the caller passed can justify a drop', () => {
      const { prompt, dropCheck } = skeptic()
      assert.ok(dropCheck.includes('APPROVED PLAN DOCS'), dropCheck)
      assert.match(prompt, /APPROVED PLAN DOCS \(passed by the caller[^\n]*\n<<<APPROVED_PLAN_DOCS>>>/)
    })

    test('a plan doc the PR adds or changes can never appear in the drop rule', () => {
      const { dropCheck } = skeptic()
      assert.ok(!dropCheck.includes('UNVERIFIED'), 'check 4 must not name the PR\'s own plan docs')
      const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
      assert.match(skill.slice(skill.indexOf('## Step 4')), /only `passed` docs go in its approved list/)
    })

    test('calls the PR\'s own plan docs unverified context, never approved', () => {
      const { prompt } = skeptic()
      const unverifiedBlock = prompt.slice(prompt.indexOf('UNVERIFIED PLAN DOCS'), prompt.indexOf('<<<UNVERIFIED_PLAN_DOCS>>>'))
      assert.match(unverifiedBlock, /context only/)
      assert.doesNotMatch(unverifiedBlock, /approved/i)
    })

    test('never drops a correctness or security finding because a plan asks for the behaviour', () => {
      const { dropCheck } = skeptic()
      assert.match(dropCheck, /never.*correctness or security/i)
    })
  })

  test('runs one general reviewer, which also covers test strength, with no second generic one', () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    assert.doesNotMatch(skill, /Generic-PR/)
    const generalPrompt = readText(GENERAL_PROMPT)
    assert.match(generalPrompt, /Tests that pass for the wrong reason/)
    assert.match(generalPrompt, /reviewer: "Anthropic"/)
  })

  test('keeps role framing only where it steers: the skeptic\'s stance and each persona\'s name', () => {
    assert.doesNotMatch(readText(GENERAL_PROMPT), /You are a senior/)
    assert.match(readText(PERSONA_PROMPT), /^You are <<<PERSONA_NAME>>>, one reviewer on a team\./m)
    assert.match(readText(SKEPTIC_PROMPT), /^You are a skeptical senior engineer\./m)
  })

  test('never hardcodes a reviewer model: render-prompts.mjs picks each one from the variant', () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    assert.doesNotMatch(skill, /model: "sonnet"/i)
    assert.match(skill, /spawn one agent per entry in `agents`, with its `model`/)
  })

  test('has no dollar sign before a digit, which Claude Code replaces with a skill argument', () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    const argumentPlaceholders = skill.split('\n').filter(line => /\$\d/.test(line))
    assert.deepEqual(argumentPlaceholders, [])
  })

  test('states its per-run cost budget', () => {
    assert.match(readText(path.join(SKILL_DIR, 'SKILL.md')), /^## Cost/m)
  })
})

describe('team', () => {
  let parsePersona

  beforeEach(async () => {
    ;({ parsePersona } = await import(VALIDATE_TEAM))
  })

  test('ships the five core personas, each always in scope', () => {
    for (const [fileName, expectedName] of Object.entries(CORE_PERSONAS)) {
      const persona = parsePersona(readText(path.join(TEAM_DIR, fileName)))
      assert.equal(persona.name, expectedName)
      assert.deepEqual(persona.scope, ['**'])
      assert.ok(persona.rules.length > 0, `${fileName}: no rules`)
    }
  })

  test('each core persona leaves the other lenses alone with at least one "Do not flag" rule', () => {
    for (const fileName of Object.keys(CORE_PERSONAS)) {
      const { rules } = parsePersona(readText(path.join(TEAM_DIR, fileName)))
      assert.ok(rules.some(rule => /^do not flag/i.test(rule.text)), `${fileName}: no "Do not flag" guardrail`)
    }
  })

  test('every area persona ships Signals, and none fires on ordinary code', () => {
    const ordinaryLines = ["import { useState } from 'react'", 'return null', 'const total = items.length', '}', '', 'export default App']
    for (const fileName of Object.keys(AREA_PERSONAS)) {
      const { signals } = parsePersona(readText(path.join(TEAM_DIR, fileName)))
      assert.ok(signals.length > 0, `${fileName}: no Signals`)
      for (const signal of signals) {
        const firedOn = ordinaryLines.find(line => signal.test(line))
        assert.equal(firedOn, undefined, `${fileName}: signal ${signal} fires on "${firedOn}"`)
      }
    }
  })

  test('core personas carry no Signals: they already review every PR', () => {
    for (const fileName of Object.keys(CORE_PERSONAS)) {
      assert.deepEqual(parsePersona(readText(path.join(TEAM_DIR, fileName))).signals, [], fileName)
    }
  })

  test('selects the panel from the diff, not just the file list, and casting writes repo-specific Signals', () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    assert.match(skill, /scripts\/select-team\.mjs" "<TEAM_DIR>" "<RUN_DIR>\/files\.txt" "<RUN_DIR>\/diff\.patch"/)
    const castingPrompt = readText(CASTING_PROMPT)
    assert.match(castingPrompt, /^Signals:$/m)
    assert.match(castingPrompt, /rewrite its Signals for this repo/)
  })

  test('ships the area personas, each scoped to its area rather than the whole repo', () => {
    for (const [fileName, expectedName] of Object.entries(AREA_PERSONAS)) {
      const persona = parsePersona(readText(path.join(TEAM_DIR, fileName)))
      assert.equal(persona.name, expectedName)
      assert.ok(persona.scope.length > 0, `${fileName}: no scope`)
      assert.ok(!persona.scope.includes('**'), `${fileName}: an area persona must not be in scope for every file`)
    }
  })

  test('has a casting prompt fed by repo signals and discovered rule sources', () => {
    const castingPrompt = readText(CASTING_PROMPT)
    assert.ok(castingPrompt.includes('<<<REPO_SIGNALS>>>'))
    assert.ok(castingPrompt.includes('<<<RULE_SOURCES>>>'))
  })

  test("casts from a checkout of the base commit, never the PR's own code", () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    const castStep = skill.slice(skill.indexOf('**Cast**'), skill.indexOf('**Pick the panel:**'))
    assert.match(castStep, /git worktree add --detach "<RUN_DIR>\/base" "\$\(cat "<RUN_DIR>\/base\.txt"\)"/)
    assert.match(castStep, /git worktree remove --force "<RUN_DIR>\/base"/)
    assert.doesNotMatch(castStep, /`git ls-files/, 'casting inputs must come from the base checkout, not the PR branch')
  })

  test('offers to post only for a PR whose head is the reviewed commit, posts only on yes, and never retries a different review', async () => {
    const { REVIEW_MARKER } = await import(BUILD_PR_REVIEW)
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    const postStep = skill.slice(skill.indexOf('## Step 6'), skill.indexOf('\n## Cost\n'))
    assert.match(postStep, /gh pr view --json url,headRefOid/, 'a plain run must find the current branch\'s PR')
    assert.match(postStep, /Not offered for posting: <first line of gh's error>/, 'no PR must be reported, not silent')
    assert.match(postStep, /differs from `<RUN_DIR>\/head\.txt`, do not offer to post/)
    assert.match(postStep, /Post this review to <url> as inline comments\? \(yes\/no\)/)
    assert.match(postStep, /On anything but an explicit yes, print `Not posted\.`/)
    assert.match(postStep, /gh pr diff <url> > "<RUN_DIR>\/pr-diff\.patch"/, 'comments must be built against the PR\'s own diff')
    assert.match(postStep, /scripts\/build-pr-review\.mjs/)
    assert.match(postStep, /Never retry/)
    assert.ok(postStep.includes(REVIEW_MARKER), 'the earlier-review check must look for the marker build-pr-review.mjs writes')
  })

  test('runs the prechecks in Step 1 at the head under review, and carries them into the merge and the telemetry', () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    const gatherStep = skill.slice(skill.indexOf('## Step 1 '), skill.indexOf('## Step 1b'))
    assert.match(gatherStep, /scripts\/precheck\.mjs" "<RUN_DIR>" --repo \./)
    assert.match(gatherStep, /--plan/, 'the prechecks must see the plan docs the caller passes')
    const collectStep = skill.slice(skill.indexOf('**Collect.**'), skill.indexOf('## Step 3'))
    assert.match(collectStep, /precheck\.json/)
    assert.match(skill, /^Prechecks: /m, 'the telemetry must say what the prechecks found')
  })

  test('takes the developer\'s taste file only through --taste or LENS_REVIEW_TASTE, and casts it into the personas', () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    assert.match(parseFrontmatter(skill).description, /--taste <path>/)
    const castStep = skill.slice(skill.indexOf('**Cast**'), skill.indexOf('**Pick the panel:**'))
    assert.match(castStep, /discover-rule-sources\.mjs" --repo "<RUN_DIR>\/base" --files "<RUN_DIR>\/all-files\.txt" \[--taste "<path>"\]/)
    const castingPrompt = readText(CASTING_PROMPT)
    assert.match(castingPrompt, /\(source: taste\)/)
    assert.match(castingPrompt, /repo's own rule sources win/)
    assert.match(readText(path.join(REPO_ROOT, 'README.md')), /taste[^\n]*--recast|--recast[^\n]*taste/)
  })

  test('gives the plan docs to the Domain Expert and the Data Steward, whose findings depend on the plan', () => {
    const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))
    assert.match(skill, /scripts\/discover-plan-docs\.mjs" --files "<RUN_DIR>\/files\.txt"/)
    assert.ok(readText(PERSONA_PROMPT).includes('<<<PLAN_NOTE>>>'))
    assert.match(skill, /the plan note for The Domain Expert and The Data Steward/)
  })

  test('the Data Steward keeps migrations in order with the planned and unmerged ones', async () => {
    const { parsePersona } = await import(VALIDATE_TEAM)
    const { rules } = parsePersona(readText(path.join(TEAM_DIR, 'data-steward.md')))
    assert.ok(rules.some(rule => rule.severity === 'must' && /timestamp sorts after every migration already merged and before none that is planned or still unmerged/.test(rule.text)))
  })

  test('has a challenge prompt that shows the team the merged findings', () => {
    assert.ok(readText(CHALLENGE_PROMPT).includes('<<<MERGED_FINDINGS>>>'))
  })

  test('ships only generic checklist sections, no repo-specific ones', () => {
    const checklist = readText(path.join(SKILL_DIR, 'checklist.md'))
    assert.match(checklist, /^## Correctness/m)
    assert.doesNotMatch(checklist, /Repo-Specific/)
  })
})

describe('tally-challenges.mjs', () => {
  let tallyChallenges

  beforeEach(async () => {
    ;({ tallyChallenges } = await import(TALLY_CHALLENGES))
  })

  test('attaches agree/dispute votes to the finding they reference', () => {
    const { findings } = tallyChallenges(
      [merged('F1', ['Security'])],
      [
        { persona: 'Performance', votes: [{ id: 'F1', verdict: 'agree', reason: 'Real' }] },
        { persona: 'Architecture', votes: [{ id: 'F1', verdict: 'dispute', reason: 'Handled upstream' }] },
      ],
    )
    assert.deepEqual(findings[0].challenge.agree.map(vote => vote.persona), ['Performance'])
    assert.deepEqual(findings[0].challenge.dispute, [{ persona: 'Architecture', reason: 'Handled upstream' }])
  })

  test('marks a finding contested when disputes outnumber agreements', () => {
    const { findings } = tallyChallenges(
      [merged('F1', ['Security'])],
      [
        { persona: 'Performance', votes: [{ id: 'F1', verdict: 'dispute', reason: 'No' }] },
        { persona: 'Architecture', votes: [{ id: 'F1', verdict: 'dispute', reason: 'No' }] },
      ],
    )
    assert.equal(findings[0].contested, true)
  })

  test('ignores a persona voting on its own finding', () => {
    const { findings } = tallyChallenges(
      [merged('F1', ['Security'])],
      [{ persona: 'Security', votes: [{ id: 'F1', verdict: 'agree', reason: 'Mine' }] }],
    )
    assert.deepEqual(findings[0].challenge.agree, [])
    assert.equal(findings[0].contested, false)
  })

  test('drops and reports votes for unknown finding ids or unknown verdicts', () => {
    const { dropped } = tallyChallenges(
      [merged('F1', ['Security'])],
      [
        {
          persona: 'Performance',
          votes: [
            { id: 'F99', verdict: 'agree', reason: 'Ghost' },
            { id: 'F1', verdict: 'maybe', reason: 'Unsure' },
          ],
        },
      ],
    )
    assert.equal(dropped.length, 2)
  })

  test('counts one vote per persona per finding and reports the repeats as dropped', () => {
    const { findings, dropped } = tallyChallenges(
      [merged('F1', ['Security'])],
      [
        {
          persona: 'Performance',
          votes: [
            { id: 'F1', verdict: 'dispute', reason: 'No' },
            { id: 'F1', verdict: 'dispute', reason: 'Still no' },
          ],
        },
        { persona: 'Architecture', votes: [{ id: 'F1', verdict: 'agree', reason: 'Real' }] },
      ],
    )
    assert.equal(findings[0].challenge.dispute.length, 1)
    assert.equal(findings[0].contested, false)
    assert.equal(dropped.length, 1)
  })

  test('drops and reports a ballot with no persona or no votes array', () => {
    const { findings, dropped } = tallyChallenges([merged('F1', ['Security'])], [{ votes: [] }, { persona: 'Performance' }])
    assert.equal(dropped.length, 2)
    assert.equal(findings[0].contested, false)
  })

  test('CLI prints the tallied findings as JSON on stdout', () => {
    const inputDir = makeTempDir('tally-input')
    const findingsPath = path.join(inputDir, 'merged.json')
    const votesPath = path.join(inputDir, 'votes-performance.json')
    fs.writeFileSync(findingsPath, JSON.stringify([merged('F1', ['Security'])]))
    fs.writeFileSync(votesPath, JSON.stringify({ persona: 'Performance', votes: [{ id: 'F1', verdict: 'dispute', reason: 'No' }] }))
    const result = runScript('node', [TALLY_CHALLENGES, findingsPath, votesPath])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout)[0].contested, true)
  })

  test('CLI exits non-zero and names the file when a votes file is not valid JSON', () => {
    const inputDir = makeTempDir('tally-input')
    const findingsPath = path.join(inputDir, 'merged.json')
    const votesPath = path.join(inputDir, 'votes-performance.json')
    fs.writeFileSync(findingsPath, JSON.stringify([merged('F1', ['Security'])]))
    fs.writeFileSync(votesPath, '{ broken')
    const result = runScript('node', [TALLY_CHALLENGES, findingsPath, votesPath])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /votes-performance\.json/)
  })
})

describe('lens-review-eval/score-review.mjs', () => {
  const expected = {
    must_catch: [
      { file: 'src/orders.ts', line_range: [10, 12], category: 'security' },
      { file: 'src/orders.ts', line_range: [20, 20] },
    ],
    must_drop: [{ file: 'src/render.ts', line_range: [5, 5] }],
  }
  let scoreReview

  beforeEach(async () => {
    ;({ scoreReview } = await import(SCORE_REVIEW))
  })

  test('passes when every seeded issue is caught and the seeded non-issue is dropped', () => {
    const result = scoreReview(expected, [
      merged('F1', ['Security'], { file: 'src/orders.ts', line: 11, category: 'security' }),
      merged('F2', ['Correctness'], { file: 'src/orders.ts', line: 20 }),
    ])
    assert.equal(result.passed, true)
  })

  test('fails and lists the seeded issue the review missed', () => {
    const result = scoreReview(expected, [merged('F1', ['Security'], { file: 'src/orders.ts', line: 11, category: 'security' })])
    assert.equal(result.passed, false)
    assert.deepEqual(result.missed, [expected.must_catch[1]])
  })

  test('a catch in the right place but the wrong category does not count', () => {
    const result = scoreReview(expected, [
      merged('F1', ['Performance'], { file: 'src/orders.ts', line: 11, category: 'performance' }),
      merged('F2', ['Correctness'], { file: 'src/orders.ts', line: 20 }),
    ])
    assert.deepEqual(result.missed, [expected.must_catch[0]])
  })

  test('fails when the seeded non-issue survives the skeptic', () => {
    const result = scoreReview(expected, [
      merged('F1', ['Security'], { file: 'src/orders.ts', line: 11, category: 'security' }),
      merged('F2', ['Correctness'], { file: 'src/orders.ts', line: 20 }),
      merged('F3', ['Security'], { file: 'src/render.ts', line: 5, category: 'security' }),
    ])
    assert.equal(result.passed, false)
    assert.equal(result.falsePositives.length, 1)
  })

  test('a must_drop that names a category only counts surviving findings making that claim', () => {
    const xssNonIssue = {
      must_catch: [],
      must_drop: [{ file: 'src/render.ts', line_range: [5, 7], category: 'security' }],
    }
    const consistencyNote = scoreReview(xssNonIssue, [
      merged('F1', ['The Maintainer'], { file: 'src/render.ts', line: 6, category: 'maintainability' }),
    ])
    assert.equal(consistencyNote.passed, true)
    const xssClaim = scoreReview(xssNonIssue, [merged('F1', ['Generic'], { file: 'src/render.ts', line: 6, category: 'security' })])
    assert.equal(xssClaim.passed, false)
    assert.equal(xssClaim.falsePositives.length, 1)
  })

  test('a catch credited to the wrong reviewer does not count when the seed names one', () => {
    const withReviewer = { must_catch: [{ file: 'src/Checkout.tsx', line_range: [8, 8], reviewer: 'Guardian' }], must_drop: [] }
    const caughtByGeneric = scoreReview(withReviewer, [merged('F1', ['Generic'], { file: 'src/Checkout.tsx', line: 8 })])
    assert.equal(caughtByGeneric.passed, false)
    const caughtByGuardian = scoreReview(withReviewer, [
      merged('F1', ['Generic', 'The Design System Guardian'], { file: 'src/Checkout.tsx', line: 8 }),
    ])
    assert.equal(caughtByGuardian.passed, true)
  })

  test('a duplication catch must point at the existing code the seed names', () => {
    const withDuplicate = {
      must_catch: [{ file: 'src/format.ts', line_range: [3, 6], duplicates: 'src/utils/money.ts' }],
      must_drop: [],
    }
    const withoutPointer = scoreReview(withDuplicate, [merged('F1', ['The Reuse Scout'], { file: 'src/format.ts', line: 4 })])
    assert.equal(withoutPointer.passed, false)
    const withPointer = scoreReview(withDuplicate, [
      merged('F1', ['The Reuse Scout'], { file: 'src/format.ts', line: 4, duplicates: 'src/utils/money.ts:2' }),
    ])
    assert.equal(withPointer.passed, true)
  })

  test('CLI exits 0 on a passing score and non-zero on a failing one', () => {
    const inputDir = makeTempDir('score-input')
    const expectedPath = path.join(inputDir, 'expected.json')
    const actualPath = path.join(inputDir, 'final-findings.json')
    fs.writeFileSync(expectedPath, JSON.stringify({ must_catch: [{ file: 'src/a.ts', line_range: [1, 2] }], must_drop: [] }))
    const score = () => runScript('node', [SCORE_REVIEW, '--expected', expectedPath, '--actual', actualPath])
    fs.writeFileSync(actualPath, JSON.stringify([merged('F1', ['Generic'], { file: 'src/a.ts', line: 2 })]))
    assert.equal(score().status, 0)
    fs.writeFileSync(actualPath, '[]')
    const failing = score()
    assert.notEqual(failing.status, 0)
    assert.deepEqual(JSON.parse(failing.stdout).missed, [{ file: 'src/a.ts', line_range: [1, 2] }])
  })

  test('CLI exits non-zero on a malformed findings file', () => {
    const inputDir = makeTempDir('score-input')
    const actualPath = path.join(inputDir, 'final-findings.json')
    fs.writeFileSync(actualPath, '{"not": "an array"}')
    const result = runScript('node', [
      SCORE_REVIEW,
      '--expected',
      path.join(SEEDED_PR_DIR, 'expected.json'),
      '--actual',
      actualPath,
    ])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /final-findings\.json/)
  })
})

describe('seeded PR fixture', () => {
  test('every must_drop names the category of the false claim it seeds, not just a location', () => {
    for (const seeded of readExpected().must_drop) {
      assert.ok(seeded.category, `must_drop at ${seeded.file} names no category, so any finding there would count`)
    }
  })

  test('seeds a core-lens issue, a project-rule violation and a non-issue', () => {
    const { must_catch: mustCatch, must_drop: mustDrop } = readExpected()
    assert.ok(mustCatch.length >= 2)
    assert.ok(mustDrop.length >= 1)
    const projectRuleSeed = mustCatch.find(seeded => seeded.source === 'project-rule')
    assert.ok(projectRuleSeed, 'no seeded AGENTS.md violation')
    assert.match(projectRuleSeed.reviewer ?? '', /Guardian/, 'the AGENTS.md seed must be credited to the Guardian')
    assert.ok(fs.existsSync(path.join(SEEDED_PR_DIR, 'base', 'AGENTS.md')), 'base/ has no AGENTS.md rule source')
  })

  test('seeds a duplicate of code that already exists in base/, for the Reuse Scout', () => {
    const seededDuplicate = readExpected().must_catch.find(seeded => seeded.source === 'reuse')
    assert.ok(seededDuplicate, 'no seeded duplication')
    assert.match(seededDuplicate.reviewer ?? '', /Reuse Scout/, 'the duplication seed must be credited to the Reuse Scout')
    const [existingFile] = seededDuplicate.duplicates.split(':')
    assert.ok(fs.existsSync(path.join(SEEDED_PR_DIR, 'base', existingFile)), `${existingFile} is not in base/`)
  })

  test('change.patch applies cleanly onto base/ and touches every seeded file', () => {
    const repoDir = buildSeededRepo()
    const changedFiles = git(repoDir, 'diff', '--name-only', 'main...HEAD').split('\n')
    const { must_catch: mustCatch, must_drop: mustDrop } = readExpected()
    for (const seeded of [...mustCatch, ...mustDrop]) {
      assert.ok(changedFiles.includes(seeded.file), `${seeded.file} is not part of change.patch`)
    }
  })
})

describe('live eval against the seeded PR', () => {
  const isLiveEvalEnabled = process.env.RUN_LIVE_EVAL === '1'

  test(
    'catches every seeded issue and drops the seeded non-issue',
    { skip: !isLiveEvalEnabled && 'set RUN_LIVE_EVAL=1 to run (spends a real review plus a first-run casting; see the ## Cost section of SKILL.md)', timeout: LIVE_EVAL_TIMEOUT_MS },
    () => {
      const repoDir = buildSeededRepo()
      const review = runScript('claude', ['-p', `/${SKILL_NAME} --base main`], {
        cwd: repoDir,
        timeout: LIVE_EVAL_TIMEOUT_MS,
        // Always casts a fresh team, and never touches the developer's saved teams.
        env: { ...process.env, LENS_REVIEW_HOME: makeTempDir('lens-review-home') },
      })
      assert.equal(review.status, 0, review.stderr)
      assert.match(review.stdout, /^Panel: .*Guardian/m, 'the frontend change did not bring the Guardian onto the panel')
      assert.match(review.stdout, /^Challenge round: \d+ personas voted/m, 'the team challenge round did not run')
      const findingsPath = review.stdout.match(/^Findings JSON: (.+)$/m)?.[1]
      assert.ok(findingsPath, 'report does not print the "Findings JSON: <path>" line')
      const score = runScript('node', [
        SCORE_REVIEW,
        '--expected',
        path.join(SEEDED_PR_DIR, 'expected.json'),
        '--actual',
        findingsPath.trim(),
      ])
      assert.equal(score.status, 0, score.stdout + score.stderr)
    },
  )
})
