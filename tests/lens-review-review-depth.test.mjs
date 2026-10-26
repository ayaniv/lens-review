import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SCRIPTS_DIR, SKILL_DIR, git, makeGitRepo, makeTempDir, readText, runScript, writeFiles } from './helpers.mjs'

// The review-depth changes from the ReviewBench pilot: reviewers look past the diff and file one
// issue per finding, a precheck catches undeclared dependencies, and an optional --context file
// (the PR's description) reaches every reviewer and the skeptic.
const RENDER_PROMPTS = path.join(SCRIPTS_DIR, 'render-prompts.mjs')
const GATHER_DIFF = path.join(SCRIPTS_DIR, 'gather-diff.sh')
const PRECHECK = path.join(SCRIPTS_DIR, 'precheck.mjs')
const SHARED_RULES = path.join(SKILL_DIR, 'reviewer-shared-rules.md')
const UNDECLARED_DEPENDENCY = 'undeclared-dependency'

const PR_CONTEXT = 'Add a freshness check\n\nfeat: skip the request when the review is current\n'
const CALLER_CONTEXT = 'PR body: adds CheckStatus(), which returns the pending and the fresh state in one pass.\n'
const PERSONA = name => `# ${name}\n\nScope:\n- **\n\nRules:\n- [should] A rule.\n- Do not flag style.\n`

function lastLine(output) {
  return output.trim().split('\n').at(-1)
}

describe('reviewer prompts look past the diff and file one issue per finding', () => {
  let runDir
  let teamDir

  beforeEach(() => {
    runDir = makeTempDir('depth-run')
    teamDir = makeTempDir('depth-team')
    writeFiles(teamDir, { 'maintainer.md': PERSONA('The Maintainer'), 'domain-expert.md': PERSONA('The Domain Expert') })
    writeFiles(runDir, {
      'pr-context.txt': PR_CONTEXT,
      'rule-sources.json': '[]',
      'plan-docs.json': JSON.stringify({ passed: [], fromPr: [] }),
      'panel.json': JSON.stringify({
        panel: 'Panel: core ×2',
        selected: [
          { file: 'maintainer.md', name: 'The Maintainer', matchedBy: [] },
          { file: 'domain-expert.md', name: 'The Domain Expert', matchedBy: [] },
        ],
        uncoveredFiles: [],
      }),
      'tallied.json': JSON.stringify([{ id: 'F1', file: 'src/a.ts', line: 3, contested: false }]),
    })
  })

  function renderAll() {
    const review = runScript('node', [RENDER_PROMPTS, runDir, teamDir])
    assert.equal(review.status, 0, review.stderr)
    const skeptic = runScript('node', [RENDER_PROMPTS, runDir, teamDir, '--phase', 'skeptic'])
    assert.equal(skeptic.status, 0, skeptic.stderr)
    return JSON.parse(review.stdout).agents.map(agent => agent.stem)
  }

  function prompt(stem) {
    return readText(path.join(runDir, `prompt-${stem}.txt`))
  }

  test('every reviewer prompt carries the one shared rules file, not its own copy', () => {
    assert.ok(fs.existsSync(SHARED_RULES), 'reviewer-shared-rules.md is missing')
    const sharedRules = readText(SHARED_RULES).trim()
    const stems = renderAll()
    assert.deepEqual(stems, ['anthropic', 'deep-pass', 'maintainer', 'domain-expert'])
    for (const stem of stems) assert.ok(prompt(stem).includes(sharedRules), `${stem} lacks the shared reviewer rules`)
    for (const template of ['reviewer-general-prompt.md', 'reviewer-deep-pass-prompt.md', 'reviewer-persona-prompt.md']) {
      assert.match(readText(path.join(SKILL_DIR, template)), /<<<REVIEWER_SHARED_RULES>>>/, `${template} does not take the shared rules`)
    }
  })

  test('the shared rules send reviewers to the real definitions and callers, and name what to check there', () => {
    const sharedRules = readText(SHARED_RULES)
    const mustCover = {
      'open the callers': /callers?/i,
      'open the real definition': /definition/i,
      'compare a mock with the real signature': /signature/i,
      'compare a mock with the real return': /return/i,
      'check the call order': /order/i,
      'check the production wiring': /production/i,
      'check the dependency manifest': /manifest/i,
      'check the PR context against the code': /diverg[^\n]*PR context|PR context[^\n]*diverg/i,
    }
    for (const [what, pattern] of Object.entries(mustCover)) assert.match(sharedRules, pattern, `shared rules do not ${what}`)
  })

  test('the shared rules ask for one issue per finding, anchored at the line that holds the defect', () => {
    const sharedRules = readText(SHARED_RULES)
    assert.match(sharedRules, /one finding per issue/i)
    assert.match(sharedRules, /defect/i)
  })

  test('the persona prompt no longer limits findings to what is clearly present in the diff', () => {
    assert.doesNotMatch(readText(path.join(SKILL_DIR, 'reviewer-persona-prompt.md')), /clearly present in the diff/i)
  })

  test('the skeptic sees the PR context, so it can check a finding that the code diverges from it', () => {
    renderAll()
    assert.ok(prompt('skeptic').includes(PR_CONTEXT.trim()))
  })

  test('a --context file reaches every reviewer and the skeptic, ahead of the commit messages', () => {
    fs.writeFileSync(path.join(runDir, 'context.txt'), CALLER_CONTEXT)
    const stems = renderAll()
    for (const stem of [...stems, 'skeptic']) {
      const text = prompt(stem)
      const contextAt = text.indexOf(CALLER_CONTEXT.trim())
      assert.ok(contextAt !== -1, `${stem} lacks the --context text`)
      assert.ok(contextAt < text.indexOf(PR_CONTEXT.trim()), `${stem} puts the --context text after pr-context.txt`)
    }
  })

  test('without a --context file the prompts render from pr-context.txt alone, as before', () => {
    const stems = renderAll()
    for (const stem of [...stems, 'skeptic']) assert.ok(prompt(stem).includes(PR_CONTEXT.trim()), `${stem} lacks the PR context`)
  })
})

describe('gather-diff.sh --context', () => {
  let repoDir

  beforeEach(() => {
    repoDir = makeGitRepo({ 'src/a.ts': 'export const a = 1\n' }, { 'src/a.ts': 'export const a = 2\n' })
  })

  test('copies the context file into the run dir as context.txt', () => {
    const contextPath = path.join(makeTempDir('depth-context'), 'pr.md')
    fs.writeFileSync(contextPath, CALLER_CONTEXT)
    const result = runScript('bash', [GATHER_DIFF, '--base', 'main', '--context', contextPath], { cwd: repoDir })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readText(path.join(lastLine(result.stdout), 'context.txt')), CALLER_CONTEXT)
  })

  test('fails naming the context file when it cannot be read', () => {
    const missing = path.join(makeTempDir('depth-context'), 'no-such-description.md')
    const result = runScript('bash', [GATHER_DIFF, '--base', 'main', '--context', missing], { cwd: repoDir })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^lens-review: .*no-such-description\.md/m)
  })

  test('writes no context.txt when no --context is passed', () => {
    const result = runScript('bash', [GATHER_DIFF, '--base', 'main'], { cwd: repoDir })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.existsSync(path.join(lastLine(result.stdout), 'context.txt')), false)
  })
})

describe('SKILL.md takes --context', () => {
  const skill = readText(path.join(SKILL_DIR, 'SKILL.md'))

  test('documents --context <path> in its usage line', () => {
    const description = skill.match(/^description: (.*)$/m)[1]
    assert.match(description, /--context <path>/)
  })

  test('passes --context to gather-diff.sh in both the PR URL and the local mode', () => {
    const step1 = skill.slice(skill.indexOf('## Step 1 '), skill.indexOf('## Step 1b'))
    const prUrlMode = step1.split('\n').find(line => line.startsWith('- **PR URL given:**'))
    const localMode = step1.split('\n').find(line => line.startsWith('- **Otherwise:**'))
    assert.match(prUrlMode, /--context/)
    assert.match(localMode, /--context/)
  })
})

describe('prechecks/undeclared-dependency.mjs, end to end through precheck.mjs', () => {
  // The same path a real run takes: gather-diff.sh, head.txt, then precheck.mjs at that head.
  function runPrecheck(filesOnMain, filesOnFeature) {
    const repoDir = makeGitRepo({ 'README.md': 'fixture\n', ...filesOnMain }, filesOnFeature)
    const gathered = runScript('bash', [GATHER_DIFF, '--base', 'main'], { cwd: repoDir })
    assert.equal(gathered.status, 0, gathered.stderr)
    const runDir = lastLine(gathered.stdout)
    fs.writeFileSync(path.join(runDir, 'head.txt'), `${git(repoDir, 'rev-parse', 'HEAD')}\n`)
    const result = runScript('node', [PRECHECK, runDir, '--repo', repoDir])
    assert.equal(result.status, 0, result.stderr)
    return { result, summary: JSON.parse(result.stdout), findings: JSON.parse(readText(path.join(runDir, 'precheck.json'))) }
  }

  function undeclaredFindings(filesOnMain, filesOnFeature) {
    const { summary, findings } = runPrecheck(filesOnMain, filesOnFeature)
    assert.deepEqual(summary.failedChecks, [])
    return findings.filter(finding => finding.check === UNDECLARED_DEPENDENCY)
  }

  const PYPROJECT = deps => `[project]\nname = "chat"\ndependencies = ["requests"]\n\n[project.optional-dependencies]\ndev = [${deps.map(dep => `"${dep}"`).join(', ')}]\n`
  const PLUGIN_TEST = [
    'import pytest',
    'from chat.client import send',
    '',
    '',
    '@pytest.mark.asyncio',
    'async def test_send(mocker):',
    "    mocker.patch('chat.client.post', return_value='hi')",
    "    assert await send('x') == 'hi'",
    '',
  ].join('\n')
  const CHAT_CLIENT = 'def post(text):\n    return text\n\n\nasync def send(text):\n    return post(text)\n'

  test('flags a test that uses pytest plugins the manifest never declares, once, at the first use', () => {
    const findings = undeclaredFindings(
      { 'pyproject.toml': PYPROJECT(['pytest']), 'src/chat/client.py': CHAT_CLIENT },
      { 'tests/test_client.py': PLUGIN_TEST },
    )
    assert.equal(findings.length, 1, JSON.stringify(findings))
    const [finding] = findings
    assert.equal(finding.file, 'tests/test_client.py')
    assert.equal(finding.line, 5)
    assert.equal(finding.severity, 'must')
    assert.equal(finding.reviewer, 'Precheck')
    assert.deepEqual([...finding.packages].sort(), ['pytest-asyncio', 'pytest-mock'])
  })

  test('stays quiet when the manifest declares both plugins, whatever their spelling', () => {
    const findings = undeclaredFindings(
      { 'pyproject.toml': PYPROJECT(['pytest', 'pytest-mock>=3', 'Pytest_Asyncio']), 'src/chat/client.py': CHAT_CLIENT },
      { 'tests/test_client.py': PLUGIN_TEST },
    )
    assert.deepEqual(findings, [])
  })

  test('counts a plugin declared in a requirements file too', () => {
    const findings = undeclaredFindings(
      { 'pyproject.toml': PYPROJECT(['pytest']), 'requirements-dev.txt': 'pytest-mock==3.14\npytest-asyncio\n', 'src/chat/client.py': CHAT_CLIENT },
      { 'tests/test_client.py': PLUGIN_TEST },
    )
    assert.deepEqual(findings, [])
  })

  test('stays quiet in a repo with no Python manifest at all', () => {
    assert.deepEqual(undeclaredFindings({ 'src/chat/client.py': CHAT_CLIENT }, { 'tests/test_client.py': PLUGIN_TEST }), [])
  })

  const PACKAGE_JSON = JSON.stringify({ name: 'app', workspaces: ['packages/*'], dependencies: { react: '^18.3.1' }, devDependencies: { vitest: '^1.6.0' } })
  const DECLARED_IMPORTS = [
    "import fs from 'fs'",
    "import path from 'node:path'",
    "import React from 'react'",
    "import { describe } from 'vitest'",
    "import { shared } from '@app/shared'",
    "import { x } from './lib/x'",
    "import { y } from '@/lib/x'",
    "import { z } from 'lib/x'",
  ]
  const WORKSPACE = {
    'package.json': PACKAGE_JSON,
    'packages/shared/package.json': JSON.stringify({ name: '@app/shared' }),
    'packages/shared/index.ts': 'export const shared = 1\n',
    'src/lib/x.ts': 'export const x = 1\nexport const y = 2\nexport const z = 3\n',
  }

  test('flags bare JS imports no package.json declares, once per file, at the first one', () => {
    const source = [...DECLARED_IMPORTS, "import { parse } from 'yaml'", "const utc = require('dayjs/plugin/utc')", ''].join('\n')
    const findings = undeclaredFindings(WORKSPACE, { 'src/a.ts': source })
    assert.equal(findings.length, 1, JSON.stringify(findings))
    const [finding] = findings
    assert.equal(finding.file, 'src/a.ts')
    assert.equal(finding.line, DECLARED_IMPORTS.length + 1)
    assert.deepEqual([...finding.packages].sort(), ['dayjs', 'yaml'])
  })

  test('stays quiet on declared, builtin, workspace, relative and aliased imports', () => {
    assert.deepEqual(undeclaredFindings(WORKSPACE, { 'src/a.ts': `${DECLARED_IMPORTS.join('\n')}\n` }), [])
  })

  test('stays quiet in a repo with no package.json at all', () => {
    assert.deepEqual(undeclaredFindings({}, { 'scripts/a.mjs': "import { parse } from 'yaml'\n" }), [])
  })

  test('a package.json that is not JSON fails this check, naming the file, and the other checks still run', () => {
    const untestedError = "export function load() {\n  throw new Error('the widget cache is out of date')\n}\n"
    const { result, summary, findings } = runPrecheck(
      { 'package.json': '{ "name": "app", ' },
      { 'src/a.ts': "import { parse } from 'yaml'\n", 'src/load.ts': untestedError },
    )
    assert.deepEqual(summary.failedChecks, [UNDECLARED_DEPENDENCY])
    assert.match(result.stderr, /^lens-review: precheck undeclared-dependency failed: package\.json is not valid JSON/m)
    assert.ok(findings.some(finding => finding.check === 'untested-failure-path' && finding.file === 'src/load.ts'), JSON.stringify(findings))
  })

  test('ignores a package.json that is not JSON under a fixture path', () => {
    const findings = undeclaredFindings(
      { ...WORKSPACE, 'tests/fixtures/broken/package.json': '{ "name": ' },
      { 'src/a.ts': "import { parse } from 'yaml'\n" },
    )
    assert.deepEqual(findings.map(finding => finding.packages), [['yaml']])
  })
})
