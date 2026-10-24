import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SCRIPTS_DIR, git, makeGitRepo, makeTempDir, runScript, writeFiles } from './helpers.mjs'

const GATHER_DIFF = path.join(SCRIPTS_DIR, 'gather-diff.sh')
const MERGE_FINDINGS = path.join(SCRIPTS_DIR, 'merge-findings.mjs')
const DISCOVER_RULE_SOURCES = path.join(SCRIPTS_DIR, 'discover-rule-sources.mjs')
const TEAM_DIR_SCRIPT = path.join(SCRIPTS_DIR, 'team-dir.mjs')
const VALIDATE_TEAM = path.join(SCRIPTS_DIR, 'validate-team.mjs')
const SELECT_TEAM = path.join(SCRIPTS_DIR, 'select-team.mjs')
const SAVE_CAST = path.join(SCRIPTS_DIR, 'save-cast.mjs')
const PARSE_REPLY = path.join(SCRIPTS_DIR, 'parse-reply.mjs')
const BUILD_PR_REVIEW = path.join(SCRIPTS_DIR, 'build-pr-review.mjs')
const DIFF_LIB = path.join(SCRIPTS_DIR, 'lib', 'diff.mjs')

// The developer's own example of a project persona, verbatim.
const DESIGN_SYSTEM_GUARDIAN = `# Design System Guardian

Scope:
- packages/ui/**
- apps/web/**

Rules:
- Flag visual overrides of DS components
  from consuming applications.
- Flag hardcoded values where design
  tokens should be used.
- Flag duplicated DS components.
- Do not flag legitimate layout styling
  of consuming pages.
- Changes to DS visual contracts require
  explicit design approval.
`

const ARCHITECT = `# The Architect

Scope:
- **

Rules:
- [must] Shared modules do not import feature code.
- Do not flag naming or formatting.
`

const BACKEND_REVIEWER = `# The Backend Reviewer

Scope:
- services/**

Rules:
- [must] Every new endpoint checks the caller's authorization.
- Do not flag frontend code.
`

// A cast Guardian: casting narrowed its Scope to where this repo's design system lives, and its
// Signals describe what touching that design system looks like anywhere else in the repo.
function castGuardian(designSystemGlob) {
  return `# The Design System Guardian

Scope:
- ${designSystemGlob}

Signals:
- from ['"]@acme/ui['"]
- <(Button|Card)\\b[^>]*\\bstyle=

Rules:
- [must] Consuming apps do not override design-system component styles.
- Do not flag backend code.
`
}

// One diff file section; `lines` are raw hunk lines, each starting with '+', '-' or ' '.
function diffSection(file, lines, { isDeleted = false } = {}) {
  const header = isDeleted ? `--- a/${file}\n+++ /dev/null` : `--- a/${file}\n+++ b/${file}`
  return `diff --git a/${file} b/${file}\n${header}\n@@ -1,${lines.length} +1,${lines.length} @@\n${lines.join('\n')}\n`
}

const INFRA_REVIEWER = `# The Infra Reviewer

Scope:
- infra/**
- **/*.yml

Rules:
- [must] No secrets committed in config.
`

function finding(overrides) {
  return {
    file: 'src/api.ts',
    line: 10,
    severity: 'should',
    category: 'correctness',
    description: 'Missing await on save()',
    rule: 'Async operations are awaited',
    reviewer: 'Generic',
    ...overrides,
  }
}

// A diff that changes src/api.ts lines 1–60: the default finding() sits inside it.
const DIFF_PATCH = `diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,2 +1,60 @@
diff --git a/src/components/Checkout.tsx b/src/components/Checkout.tsx
new file mode 100644
--- /dev/null
+++ b/src/components/Checkout.tsx
@@ -0,0 +1,12 @@
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
--- a/src/old.ts
+++ /dev/null
@@ -1,5 +0,0 @@
`

function lastLine(output) {
  return output.trim().split('\n').at(-1)
}

describe('gather-diff.sh', () => {
  let repoDir

  beforeEach(() => {
    repoDir = makeGitRepo(
      { 'src/a.ts': 'export const a = 1\n' },
      { 'src/a.ts': 'export const a = 2\n', 'src/b.ts': 'export const b = 1\n' },
    )
  })

  test('writes the branch diff and changed-file list into a fresh run dir', () => {
    const result = runScript('bash', [GATHER_DIFF, '--base', 'main'], { cwd: repoDir })
    assert.equal(result.status, 0, result.stderr)
    const runDir = lastLine(result.stdout)
    assert.match(fs.readFileSync(path.join(runDir, 'diff.patch'), 'utf8'), /\+export const a = 2/)
    const changedFiles = fs.readFileSync(path.join(runDir, 'files.txt'), 'utf8').trim().split('\n')
    assert.deepEqual(changedFiles.sort(), ['src/a.ts', 'src/b.ts'])
  })

  test('two runs never share a run dir (no clobbering between concurrent reviews)', () => {
    const first = lastLine(runScript('bash', [GATHER_DIFF, '--base', 'main'], { cwd: repoDir }).stdout)
    const second = lastLine(runScript('bash', [GATHER_DIFF, '--base', 'main'], { cwd: repoDir }).stdout)
    assert.notEqual(first, second)
    assert.ok(fs.existsSync(path.join(first, 'diff.patch')))
    assert.ok(fs.existsSync(path.join(second, 'diff.patch')))
  })

  test('--diff reviews a patch file directly and derives files.txt from it', () => {
    const patchDir = makeTempDir('review-patch')
    const patchPath = path.join(patchDir, 'change.patch')
    fs.writeFileSync(
      patchPath,
      'diff --git a/lib/x.js b/lib/x.js\n--- a/lib/x.js\n+++ b/lib/x.js\n@@ -1 +1 @@\n-old\n+new\n',
    )
    const result = runScript('bash', [GATHER_DIFF, '--diff', patchPath], { cwd: repoDir })
    assert.equal(result.status, 0, result.stderr)
    const runDir = lastLine(result.stdout)
    assert.equal(fs.readFileSync(path.join(runDir, 'files.txt'), 'utf8').trim(), 'lib/x.js')
  })

  test("pins the a/ and b/ prefixes the merge step parses, whatever the user's diff config", () => {
    git(repoDir, 'config', 'diff.noprefix', 'true')
    git(repoDir, 'config', 'diff.external', 'false')
    git(repoDir, 'config', 'color.diff', 'always')
    const result = runScript('bash', [GATHER_DIFF, '--base', 'main'], { cwd: repoDir })
    assert.equal(result.status, 0, result.stderr)
    const patch = fs.readFileSync(path.join(lastLine(result.stdout), 'diff.patch'), 'utf8')
    assert.match(patch, /^\+\+\+ b\/src\/a\.ts$/m)
    assert.doesNotMatch(patch, /\x1b\[/)
  })

  test('records the base commit in base.txt, so casting reads the code before this PR', () => {
    const result = runScript('bash', [GATHER_DIFF, '--base', 'main'], { cwd: repoDir })
    assert.equal(result.status, 0, result.stderr)
    const baseCommit = fs.readFileSync(path.join(lastLine(result.stdout), 'base.txt'), 'utf8').trim()
    assert.equal(baseCommit, git(repoDir, 'rev-parse', 'main'))
  })

  test('--diff records the base commit too, from --base or the default branch', () => {
    const patchPath = path.join(makeTempDir('review-patch'), 'change.patch')
    fs.writeFileSync(patchPath, 'diff --git a/lib/x.js b/lib/x.js\n--- a/lib/x.js\n+++ b/lib/x.js\n@@ -1 +1 @@\n-old\n+new\n')
    const result = runScript('bash', [GATHER_DIFF, '--diff', patchPath], { cwd: repoDir })
    assert.equal(result.status, 0, result.stderr)
    const baseCommit = fs.readFileSync(path.join(lastLine(result.stdout), 'base.txt'), 'utf8').trim()
    assert.equal(baseCommit, git(repoDir, 'rev-parse', 'main'))
  })

  test('fails loudly outside a git repository', () => {
    const result = runScript('bash', [GATHER_DIFF, '--base', 'main'], { cwd: makeTempDir('not-a-repo') })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /not a git repository/i)
  })

  test('fails loudly on an empty diff instead of reviewing nothing', () => {
    const emptyRepo = makeGitRepo({ 'a.txt': 'same\n' }, {})
    const result = runScript('bash', [GATHER_DIFF, '--base', 'main'], { cwd: emptyRepo })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /empty diff/i)
  })

  test('fails loudly when --diff points at a missing file', () => {
    const result = runScript('bash', [GATHER_DIFF, '--diff', '/nonexistent/change.patch'], { cwd: repoDir })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /change\.patch/)
  })

  test("without --base, diffs against the remote's default branch", () => {
    const upstream = makeTempDir('upstream')
    git(upstream, 'init', '-q', '-b', 'trunk')
    writeFiles(upstream, { 'a.txt': '1\n' })
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'user.email=f@x', '-c', 'user.name=F', 'commit', '-q', '-m', 'base')
    const clone = path.join(makeTempDir('clone'), 'repo')
    git(path.dirname(clone), 'clone', '-q', upstream, clone)
    git(clone, 'checkout', '-q', '-b', 'feature')
    writeFiles(clone, { 'a.txt': '2\n' })
    git(clone, '-c', 'user.email=f@x', '-c', 'user.name=F', 'commit', '-q', '-am', 'change')
    const result = runScript('bash', [GATHER_DIFF], { cwd: clone })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(path.join(lastLine(result.stdout), 'files.txt'), 'utf8').trim(), 'a.txt')
  })

  test('without --base or a remote, falls back to a local master branch', () => {
    const repo = makeTempDir('master-repo')
    git(repo, 'init', '-q', '-b', 'master')
    writeFiles(repo, { 'a.txt': '1\n' })
    git(repo, 'add', '-A')
    git(repo, '-c', 'user.email=f@x', '-c', 'user.name=F', 'commit', '-q', '-m', 'base')
    git(repo, 'checkout', '-q', '-b', 'feature')
    writeFiles(repo, { 'a.txt': '2\n' })
    git(repo, '-c', 'user.email=f@x', '-c', 'user.name=F', 'commit', '-q', '-am', 'change')
    const result = runScript('bash', [GATHER_DIFF], { cwd: repo })
    assert.equal(result.status, 0, result.stderr)
  })

  test('without --base, fails loudly asking for one when no default branch exists', () => {
    const repo = makeTempDir('trunk-repo')
    git(repo, 'init', '-q', '-b', 'trunk')
    writeFiles(repo, { 'a.txt': '1\n' })
    git(repo, 'add', '-A')
    git(repo, '-c', 'user.email=f@x', '-c', 'user.name=F', 'commit', '-q', '-m', 'base')
    const result = runScript('bash', [GATHER_DIFF], { cwd: repo })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--base/)
  })

  test('fails loudly and names the base ref when it does not exist', () => {
    const result = runScript('bash', [GATHER_DIFF, '--base', 'no-such-branch'], { cwd: repoDir })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /no-such-branch/)
  })
})

describe('merge-findings.mjs', () => {
  let mergeFindings
  let diffLines
  let diffPath

  beforeEach(async () => {
    let parseDiffLines
    ;({ mergeFindings, parseDiffLines } = await import(MERGE_FINDINGS))
    diffLines = parseDiffLines(DIFF_PATCH)
    diffPath = path.join(makeTempDir('merge-diff'), 'diff.patch')
    fs.writeFileSync(diffPath, DIFF_PATCH)
  })

  test('merges the same issue flagged by two reviewers within ±3 lines', () => {
    const { findings } = mergeFindings(
      [
        [finding({ line: 10, severity: 'should', reviewer: 'Generic' })],
        [finding({ line: 12, severity: 'must', reviewer: 'Security' })],
      ],
      diffLines,
    )
    assert.equal(findings.length, 1)
    assert.equal(findings[0].severity, 'must')
    assert.deepEqual(findings[0].reviewers, ['Generic', 'Security'])
  })

  test('keeps findings apart when the category or line distance differs', () => {
    const { findings } = mergeFindings([
      [finding({ line: 10 }), finding({ line: 14 }), finding({ line: 10, category: 'performance' })],
    ], diffLines)
    assert.equal(findings.length, 3)
  })

  test('treats categories that differ only in case or whitespace as the same', () => {
    const { findings } = mergeFindings([
      [finding({ category: 'Correctness', reviewer: 'Generic' })],
      [finding({ category: ' correctness ', reviewer: 'Security' })],
    ], diffLines)
    assert.equal(findings.length, 1)
  })

  test('assigns each merged finding a stable id for the challenge round to reference', () => {
    const { findings } = mergeFindings([[finding({ line: 1 }), finding({ line: 50 })]], diffLines)
    assert.deepEqual(
      findings.map(merged => merged.id),
      ['F1', 'F2'],
    )
  })

  test("keeps the Reuse Scout's pointer to the existing code it found", () => {
    const { findings } = mergeFindings([
      [finding({ category: 'duplication', reviewer: 'The Reuse Scout', duplicates: 'src/utils/money.ts:4' })],
    ], diffLines)
    assert.equal(findings[0].duplicates, 'src/utils/money.ts:4')
  })

  test('drops malformed findings and reports them instead of crashing', () => {
    const { findings, dropped } = mergeFindings([
      [finding({}), { file: 'src/x.ts', description: 'no line' }, finding({ line: 40, severity: 'critical' })],
    ], diffLines)
    assert.equal(findings.length, 1)
    assert.equal(dropped.length, 2)
  })

  test('CLI exits non-zero and names the file when an input is not valid JSON', () => {
    const inputDir = makeTempDir('merge-input')
    const goodPath = path.join(inputDir, 'good.json')
    const badPath = path.join(inputDir, 'bad.json')
    fs.writeFileSync(goodPath, JSON.stringify([finding({})]))
    fs.writeFileSync(badPath, 'not json [')
    const result = runScript('node', [MERGE_FINDINGS, '--diff', diffPath, goodPath, badPath])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /bad\.json/)
  })

  test('CLI prints the merged array as JSON on stdout', () => {
    const inputDir = makeTempDir('merge-input')
    const inputPath = path.join(inputDir, 'a.json')
    fs.writeFileSync(inputPath, JSON.stringify([finding({})]))
    const result = runScript('node', [MERGE_FINDINGS, '--diff', diffPath, inputPath])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).length, 1)
  })

  test('CLI exits non-zero when given no findings files instead of printing an empty review', () => {
    const result = runScript('node', [MERGE_FINDINGS, '--diff', diffPath])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /findings/i)
  })
  test("never folds two of one reviewer's findings together: each is a distinct issue", () => {
    const button = { file: 'src/components/Checkout.tsx', line: 7, category: 'design-system' }
    const { findings } = mergeFindings(
      [
        [
          finding({ ...button, rule: 'UI buttons use Button from src/ds', description: 'Raw <button> rendered', reviewer: 'Guardian' }),
          finding({ ...button, rule: 'Colors come from tokens; never hardcode a hex color', description: 'Hardcoded hex color #ff0000', reviewer: 'Guardian' }),
        ],
      ],
      diffLines,
    )
    assert.equal(findings.length, 2)
    assert.match(findings[1].description, /#ff0000/)
  })

  test("merges another reviewer's finding into the issue it describes, not just the first one nearby", () => {
    const button = { file: 'src/components/Checkout.tsx', line: 7, category: 'design-system' }
    const { findings } = mergeFindings(
      [
        [
          finding({ ...button, rule: 'UI buttons use Button from src/ds', description: 'Raw <button> rendered', reviewer: 'Guardian' }),
          finding({ ...button, rule: 'Colors come from tokens; never hardcode a hex color', description: 'Hardcoded hex color #ff0000', reviewer: 'Guardian' }),
        ],
        [
          finding({ ...button, rule: 'AGENTS.md: never hardcode a hex color', description: 'The button hardcodes the hex color #ff0000', reviewer: 'Generic' }),
          finding({ ...button, rule: 'AGENTS.md: UI buttons use Button from src/ds', description: 'Renders a raw <button>', reviewer: 'Generic' }),
        ],
      ],
      diffLines,
    )
    assert.equal(findings.length, 2)
    assert.deepEqual(findings[0].reviewers, ['Guardian', 'Generic'])
    assert.deepEqual(findings[1].reviewers, ['Guardian', 'Generic'])
    assert.match(findings[1].description, /#ff0000/)
  })

  test('maps an absolute path onto the repo-relative file the diff changed, so it still dedups', () => {
    const { findings, dropped } = mergeFindings(
      [
        [finding({ reviewer: 'Generic' })],
        [finding({ file: '/private/var/folders/xy/T/seeded-pr-abc/src/api.ts', reviewer: 'The Maintainer' })],
      ],
      diffLines,
    )
    assert.equal(dropped.length, 0)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].file, 'src/api.ts')
    assert.deepEqual(findings[0].reviewers, ['Generic', 'The Maintainer'])
  })

  test('drops a finding on a file the diff does not change, or one it deleted', () => {
    const { findings, dropped } = mergeFindings(
      [[finding({ file: 'src/untouched.ts' }), finding({ file: '/tmp/elsewhere/untouched.ts' }), finding({ file: 'src/old.ts', line: 2 })]],
      diffLines,
    )
    assert.equal(findings.length, 0)
    assert.equal(dropped.length, 3)
    assert.match(dropped[0].reason, /not a file this diff changes/)
  })

  test('drops a finding whose line is outside every changed hunk of its file', () => {
    const { findings, dropped } = mergeFindings(
      [[finding({ file: 'src/components/Checkout.tsx', line: 12 }), finding({ file: 'src/components/Checkout.tsx', line: 51 })]],
      diffLines,
    )
    assert.equal(findings.length, 1)
    assert.equal(dropped.length, 1)
    assert.match(dropped[0].reason, /line 51 is outside the diff of src\/components\/Checkout\.tsx/)
  })

  test('CLI reports findings it dropped for being outside the diff on stderr', () => {
    const inputPath = path.join(makeTempDir('merge-input'), 'a.json')
    fs.writeFileSync(inputPath, JSON.stringify([finding({}), finding({ file: 'src/untouched.ts' })]))
    const result = runScript('node', [MERGE_FINDINGS, '--diff', diffPath, inputPath])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).length, 1)
    assert.match(result.stderr, /dropped 1 malformed findings/)
  })

  test('CLI exits non-zero on a patch without a/ b/ prefixes instead of dropping every finding', () => {
    const noPrefixPath = path.join(makeTempDir('merge-diff'), 'noprefix.patch')
    fs.writeFileSync(noPrefixPath, 'diff --git src/api.ts src/api.ts\n--- src/api.ts\n+++ src/api.ts\n@@ -1,2 +1,60 @@\n')
    const inputPath = path.join(makeTempDir('merge-input'), 'a.json')
    fs.writeFileSync(inputPath, JSON.stringify([finding({})]))
    const result = runScript('node', [MERGE_FINDINGS, '--diff', noPrefixPath, inputPath])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /noprefix\.patch/)
    assert.match(result.stderr, /b\//)
  })

  test('CLI exits non-zero and says so when --diff is missing', () => {
    const inputPath = path.join(makeTempDir('merge-input'), 'a.json')
    fs.writeFileSync(inputPath, JSON.stringify([finding({})]))
    const result = runScript('node', [MERGE_FINDINGS, inputPath])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--diff/)
  })
})

describe('merge-findings.mjs: duplication across copies', () => {
  // Modelled on a real run: three e2e specs each re-declare helpers that an existing spec
  // already has, and a migration copies an older function body. Two reviewers flagged every
  // copy separately, which put seven near-identical comments on the PR.
  const SPECS_DIFF = [
    diffSection('e2e/second-parent.spec.ts', Array(80).fill('+x')),
    diffSection('e2e/names-and-seats.spec.ts', Array(120).fill('+x')),
    diffSection('e2e/standing-drives.spec.ts', Array(80).fill('+x')),
    diffSection('supabase/migrations/2_drives.sql', Array(60).fill('+x')),
  ].join('')
  const copyFindings = {
    generic: [
      duplication('e2e/second-parent.spec.ts', 21, 'childButton and enterAs are redefined here and in two other specs.', { reviewer: 'Generic' }),
      duplication('e2e/names-and-seats.spec.ts', 88, 'addFamily repeats the join_group call second-parent.spec.ts writes inline.', { reviewer: 'Generic', severity: 'suggestion' }),
    ],
    reuseScout: [
      duplication('e2e/second-parent.spec.ts', 21, 'childButton and enterAs copy the invite helpers.', { duplicates: 'e2e/invite-link-access.spec.ts:36' }),
      duplication('supabase/migrations/2_drives.sql', 31, 'ensure_practices re-defines the init body.', { duplicates: 'supabase/migrations/1_init.sql:377', severity: 'must' }),
      duplication('e2e/names-and-seats.spec.ts', 94, 'childButton is defined again with the same selector.', { duplicates: 'e2e/invite-link-access.spec.ts:27' }),
      duplication('e2e/second-parent.spec.ts', 16, 'childButton is a third copy of the pick-child selector.', { duplicates: 'e2e/invite-link-access.spec.ts:27' }),
      duplication('e2e/names-and-seats.spec.ts', 98, 'enterAs repeats the open-invite steps.', { duplicates: 'e2e/invite-link-access.spec.ts:36' }),
      duplication('e2e/standing-drives.spec.ts', 60, 'enterAs is a third copy of the open-invite steps.', { duplicates: 'e2e/invite-link-access.spec.ts:36' }),
      duplication('e2e/second-parent.spec.ts', 55, 'The inline join_group call repeats the addFamily helper.', { duplicates: 'e2e/names-and-seats.spec.ts:83' }),
    ],
  }
  let mergeFindings
  let specsDiffLines

  function duplication(file, line, description, overrides = {}) {
    return finding({ file, line, category: 'duplication', description, reviewer: 'The Reuse Scout', ...overrides })
  }

  beforeEach(async () => {
    let parseDiffLines
    ;({ mergeFindings, parseDiffLines } = await import(MERGE_FINDINGS))
    specsDiffLines = parseDiffLines(SPECS_DIFF)
  })

  test('folds every copy of the duplicated helpers into one finding that lists each location', () => {
    const { findings, dropped } = mergeFindings([copyFindings.generic, copyFindings.reuseScout], specsDiffLines)
    assert.deepEqual(dropped, [])
    const specCopies = findings.filter(merged => merged.file.startsWith('e2e/'))
    assert.equal(specCopies.length, 1)
    const [helpers] = specCopies
    assert.deepEqual(
      helpers.locations.map(({ file, line }) => `${file}:${line}`),
      [
        'e2e/second-parent.spec.ts:21',
        'e2e/names-and-seats.spec.ts:88',
        'e2e/names-and-seats.spec.ts:94',
        'e2e/second-parent.spec.ts:16',
        'e2e/names-and-seats.spec.ts:98',
        'e2e/standing-drives.spec.ts:60',
        'e2e/second-parent.spec.ts:55',
      ],
    )
    assert.deepEqual(helpers.reviewers, ['Generic', 'The Reuse Scout'])
    assert.equal(helpers.severity, 'should')
    assert.equal(helpers.duplicates, 'e2e/invite-link-access.spec.ts:36')
  })

  test('keeps a duplication that shares no file and no helper with the others as its own finding', () => {
    const { findings } = mergeFindings([copyFindings.generic, copyFindings.reuseScout], specsDiffLines)
    const migrationCopy = findings.find(merged => merged.file === 'supabase/migrations/2_drives.sql')
    assert.equal(migrationCopy.severity, 'must')
    assert.equal(migrationCopy.locations, undefined)
    assert.deepEqual(findings.map(merged => merged.id), ['F1', 'F2'])
  })

  test('links copies through a helper they both name, even in files nothing else shares', () => {
    const { findings } = mergeFindings(
      [
        [
          duplication('e2e/second-parent.spec.ts', 10, 'formatSeat repeats the seat label logic.'),
          duplication('e2e/standing-drives.spec.ts', 10, 'A second formatSeat copy.'),
        ],
      ],
      specsDiffLines,
    )
    assert.equal(findings.length, 1)
    assert.equal(findings[0].locations.length, 2)
  })

  test('never folds findings of another category, even when they name the same helper', () => {
    const { findings } = mergeFindings(
      [
        [
          duplication('e2e/second-parent.spec.ts', 10, 'formatSeat repeats the seat label logic.'),
          finding({ file: 'e2e/standing-drives.spec.ts', line: 10, category: 'correctness', description: 'formatSeat drops the last seat.' }),
        ],
      ],
      specsDiffLines,
    )
    assert.equal(findings.length, 2)
  })
})

describe('discover-rule-sources.mjs', () => {
  let discoverRuleSources
  let repoDir

  beforeEach(async () => {
    ;({ discoverRuleSources } = await import(DISCOVER_RULE_SOURCES))
    repoDir = makeTempDir('rule-sources-repo')
    writeFiles(repoDir, {
      'AGENTS.md': '# root rules\n',
      'CLAUDE.md': '# root claude\n',
      'packages/ui/AGENTS.md': '# design system rules\n',
      'packages/ui/Button.tsx': 'export {}\n',
      'packages/api/client.ts': 'export {}\n',
      '.cursor/rules/styling.mdc': '# cursor rule\n',
      '.github/copilot-instructions.md': '# copilot\n',
    })
  })

  test('returns the nearest AGENTS.md before the root ones for a changed file', () => {
    const sources = discoverRuleSources(repoDir, ['packages/ui/Button.tsx'])
    const paths = sources.map(source => source.path)
    assert.ok(paths.indexOf('packages/ui/AGENTS.md') < paths.indexOf('AGENTS.md'))
    assert.ok(paths.includes('CLAUDE.md'))
  })

  test('includes repo-wide cursor and copilot rule files with their kind', () => {
    const sources = discoverRuleSources(repoDir, ['packages/api/client.ts'])
    assert.deepEqual(
      sources.find(source => source.path === '.cursor/rules/styling.mdc'),
      { path: '.cursor/rules/styling.mdc', kind: 'cursor' },
    )
    assert.ok(sources.some(source => source.kind === 'copilot'))
  })

  test('does not pick up a sibling package rule file for an unrelated change', () => {
    const paths = discoverRuleSources(repoDir, ['packages/api/client.ts']).map(source => source.path)
    assert.ok(!paths.includes('packages/ui/AGENTS.md'))
  })

  test('lists each rule source once across many changed files', () => {
    const paths = discoverRuleSources(repoDir, ['packages/ui/Button.tsx', 'packages/api/client.ts']).map(
      source => source.path,
    )
    assert.equal(paths.length, new Set(paths).size)
  })

  test('returns [] for a repo with no rule files', () => {
    const bareRepo = makeTempDir('rule-sources-bare')
    writeFiles(bareRepo, { 'index.js': '\n' })
    assert.deepEqual(discoverRuleSources(bareRepo, ['index.js']), [])
  })

  test('CLI reads the files to cover from a --files list', () => {
    const filesList = path.join(makeTempDir('run'), 'files.txt')
    fs.writeFileSync(filesList, 'packages/ui/Button.tsx\n')
    const result = runScript('node', [DISCOVER_RULE_SOURCES, '--repo', repoDir, '--files', filesList])
    assert.equal(result.status, 0, result.stderr)
    assert.ok(JSON.parse(result.stdout).some(source => source.path === 'packages/ui/AGENTS.md'))
  })

  describe('the developer\'s taste file', () => {
    let tasteFile
    // A HOME whose ~/.claude holds a CLAUDE.md: the script must never read it on its own.
    let homeWithClaudeDir
    const discover = (args, env = {}) =>
      runScript('node', [DISCOVER_RULE_SOURCES, '--repo', repoDir, 'packages/api/client.ts', ...args], {
        env: { ...process.env, HOME: homeWithClaudeDir, LENS_REVIEW_TASTE: '', ...env },
      })

    beforeEach(() => {
      homeWithClaudeDir = makeTempDir('taste-home')
      writeFiles(homeWithClaudeDir, { '.claude/CLAUDE.md': '# personal rules\n', '.claude/settings.json': '{}\n' })
      tasteFile = path.join(makeTempDir('taste'), 'taste.md')
      fs.writeFileSync(tasteFile, '# Personal engineering taste\n- No duplication.\n')
    })

    test('--taste lists the file last, with kind "taste", after every repo rule file', () => {
      const result = discover(['--taste', tasteFile])
      assert.equal(result.status, 0, result.stderr)
      const sources = JSON.parse(result.stdout)
      assert.deepEqual(sources.at(-1), { path: tasteFile, kind: 'taste' })
      assert.equal(sources.filter(source => source.kind === 'taste').length, 1)
    })

    test('LENS_REVIEW_TASTE is the default when no --taste is passed, and --taste beats it', () => {
      const fromEnv = JSON.parse(discover([], { LENS_REVIEW_TASTE: tasteFile }).stdout)
      assert.deepEqual(fromEnv.at(-1), { path: tasteFile, kind: 'taste' })
      const otherTaste = path.join(path.dirname(tasteFile), 'other.md')
      fs.writeFileSync(otherTaste, '# other\n')
      const fromFlag = JSON.parse(discover(['--taste', otherTaste], { LENS_REVIEW_TASTE: tasteFile }).stdout)
      assert.deepEqual(fromFlag.filter(source => source.kind === 'taste'), [{ path: otherTaste, kind: 'taste' }])
    })

    test('without --taste or LENS_REVIEW_TASTE, nothing under ~/.claude is listed', () => {
      const result = discover([])
      assert.equal(result.status, 0, result.stderr)
      const sources = JSON.parse(result.stdout)
      assert.ok(!sources.some(source => source.kind === 'taste'))
      assert.ok(!sources.some(source => source.path.includes(homeWithClaudeDir)))
    })

    test('fails naming a taste file that does not exist, rather than casting without it', () => {
      const result = discover(['--taste', path.join(homeWithClaudeDir, 'missing.md')])
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /lens-review: taste file not found: .*missing\.md/)
    })
  })

  test('CLI exits non-zero when --repo does not exist', () => {
    const result = runScript('node', [DISCOVER_RULE_SOURCES, '--repo', '/nonexistent/repo', 'a.ts'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /nonexistent\/repo/)
  })
})

describe('validate-team.mjs', () => {
  let parsePersona

  beforeEach(async () => {
    ;({ parsePersona } = await import(VALIDATE_TEAM))
  })

  test('parses the Design System Guardian: name, scope globs and wrapped rules', () => {
    const persona = parsePersona(DESIGN_SYSTEM_GUARDIAN)
    assert.equal(persona.name, 'Design System Guardian')
    assert.deepEqual(persona.scope, ['packages/ui/**', 'apps/web/**'])
    assert.equal(persona.rules.length, 5)
    assert.equal(persona.rules[0].text, 'Flag visual overrides of DS components from consuming applications.')
  })

  test('reads a severity tag and defaults untagged rules to should', () => {
    const { rules } = parsePersona(ARCHITECT)
    assert.deepEqual(
      rules.map(rule => rule.severity),
      ['must', 'should'],
    )
    assert.equal(rules[0].text, 'Shared modules do not import feature code.')
  })

  test('rejects a persona with neither a Scope nor Signals: nothing could ever bring it onto a panel', () => {
    assert.throws(() => parsePersona('# Lonely\n\nRules:\n- Flag things.\n'), /no Scope globs or Signals/)
  })

  test('reads Signals as regexes over changed lines, alongside the Scope', () => {
    const persona = parsePersona(castGuardian('packages/ui/**'))
    assert.deepEqual(persona.scope, ['packages/ui/**'])
    assert.equal(persona.signals.length, 2)
    assert.ok(persona.signals[1].test('<Button size="sm" style={{ color: "red" }}>'))
  })

  test('a persona written before Signals existed still parses, with no signals', () => {
    assert.deepEqual(parsePersona(BACKEND_REVIEWER).signals, [])
  })

  test('accepts a Signals-only persona: its concern, not its location, brings it in', () => {
    const persona = parsePersona('# The Accessibility Reviewer\n\nSignals:\n- \\baria-\n\nRules:\n- Flag missing labels.\n')
    assert.deepEqual(persona.scope, [])
    assert.equal(persona.signals.length, 1)
  })

  test('rejects a signal that is not a valid regex, naming it', () => {
    assert.throws(
      () => parsePersona('# Broken\n\nSignals:\n- style=(\n\nRules:\n- Flag things.\n'),
      /Broken: signal "style=\(" is not a valid regex/,
    )
  })

  test('rejects a signal that matches every line, since it would put the persona on every PR', () => {
    for (const matchesAnything of ['x?', '.*', '^']) {
      assert.throws(
        () => parsePersona(`# Greedy\n\nSignals:\n- ${matchesAnything}\n\nRules:\n- Flag things.\n`),
        /matches an empty line/,
      )
    }
  })

  test('rejects an overlong signal, which casting output could use to stall selection', () => {
    const overlong = `a${'b?'.repeat(150)}`
    assert.throws(
      () => parsePersona(`# Long\n\nSignals:\n- ${overlong}\n\nRules:\n- Flag things.\n`),
      /longer than 200 characters/,
    )
  })

  test('rejects a persona with no rules', () => {
    assert.throws(() => parsePersona('# Empty\n\nScope:\n- **\n'), /rules/i)
  })

  test('CLI exits non-zero and names the malformed persona file', () => {
    const teamDir = makeTempDir('team')
    writeFiles(teamDir, { 'architect.md': ARCHITECT, 'broken-guardian.md': '# Broken\n' })
    const result = runScript('node', [VALIDATE_TEAM, teamDir])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /broken-guardian\.md/)
  })

  test('CLI exits non-zero on an empty team dir instead of reviewing with no one', () => {
    const result = runScript('node', [VALIDATE_TEAM, makeTempDir('empty-team')])
    assert.notEqual(result.status, 0)
  })

  // Findings and challenge votes are attributed by persona name, so two personas sharing one
  // would merge their findings and let one vote on the other's as if it were its own.
  test('CLI exits non-zero and names the file when two personas share a name', () => {
    const teamDir = makeTempDir('team')
    writeFiles(teamDir, { 'architect.md': ARCHITECT, 'architect-copy.md': ARCHITECT })
    const result = runScript('node', [VALIDATE_TEAM, teamDir])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /architect(-copy)?\.md.*The Architect/)
  })

  test('CLI lists core personas before scoped ones', () => {
    const teamDir = makeTempDir('team')
    writeFiles(teamDir, { 'a-backend.md': BACKEND_REVIEWER, 'z-architect.md': ARCHITECT })
    const result = runScript('node', [VALIDATE_TEAM, teamDir])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(
      JSON.parse(result.stdout).map(persona => persona.name),
      ['The Architect', 'The Backend Reviewer'],
    )
  })
})

describe('save-cast.mjs', () => {
  let teamDir
  let castPath

  beforeEach(() => {
    teamDir = makeTempDir('team')
    castPath = path.join(makeTempDir('run'), 'cast.json')
  })

  function saveCast(cast) {
    fs.writeFileSync(castPath, typeof cast === 'string' ? cast : JSON.stringify(cast))
    return runScript('node', [SAVE_CAST, teamDir, castPath])
  }

  test("writes each cast persona into the team dir under its file name", () => {
    const result = saveCast([
      { file: 'architect.md', markdown: ARCHITECT },
      { file: 'backend-reviewer.md', markdown: BACKEND_REVIEWER },
    ])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(fs.readdirSync(teamDir).sort(), ['architect.md', 'backend-reviewer.md'])
    assert.equal(fs.readFileSync(path.join(teamDir, 'architect.md'), 'utf8'), ARCHITECT)
  })

  // Casting reads the reviewed repo's own rule files, so its output is untrusted: a crafted
  // AGENTS.md must not be able to steer a write outside the team dir.
  test('refuses a file name that is not a bare kebab-case .md name, and writes nothing', () => {
    const result = saveCast([
      { file: 'architect.md', markdown: ARCHITECT },
      { file: '../../.bashrc.md', markdown: BACKEND_REVIEWER },
    ])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /\.\.\/\.\.\/\.bashrc\.md/)
    assert.deepEqual(fs.readdirSync(teamDir), [])
  })

  test('refuses a cast with a malformed persona, naming its file, and writes nothing', () => {
    const result = saveCast([
      { file: 'architect.md', markdown: ARCHITECT },
      { file: 'broken.md', markdown: '# Broken\n' },
    ])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /broken\.md/)
    assert.deepEqual(fs.readdirSync(teamDir), [])
  })

  test('refuses two personas cast into the same file', () => {
    const result = saveCast([
      { file: 'architect.md', markdown: ARCHITECT },
      { file: 'architect.md', markdown: BACKEND_REVIEWER },
    ])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /architect\.md/)
  })

  test('exits non-zero and names the cast file when it is not a JSON array', () => {
    const result = saveCast('{"file": "architect.md"}')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /cast\.json/)
  })
})

describe('select-team.mjs', () => {
  let selectTeam
  let formatPanel
  let parsePersona
  let team

  beforeEach(async () => {
    ;({ selectTeam, formatPanel } = await import(SELECT_TEAM))
    ;({ parsePersona } = await import(VALIDATE_TEAM))
    team = [parsePersona(ARCHITECT), parsePersona(BACKEND_REVIEWER), parsePersona(DESIGN_SYSTEM_GUARDIAN)]
  })

  function selectedNames(changedFiles) {
    return selectTeam(team, changedFiles).selected.map(persona => persona.name)
  }

  test('a backend change brings in the Backend Reviewer and not the Guardian', () => {
    assert.deepEqual(selectedNames(['services/billing/invoice.ts']), ['The Architect', 'The Backend Reviewer'])
  })

  test('a frontend change brings in the Guardian and not the Backend Reviewer', () => {
    assert.deepEqual(selectedNames(['packages/ui/Button.tsx']), ['The Architect', 'Design System Guardian'])
  })

  test('a PR touching both areas gets both area personas', () => {
    assert.deepEqual(selectedNames(['services/billing/invoice.ts', 'apps/web/Checkout.tsx']), [
      'The Architect',
      'The Backend Reviewer',
      'Design System Guardian',
    ])
  })

  test('core personas review every PR, even one no area claims', () => {
    assert.deepEqual(selectedNames(['README.md']), ['The Architect'])
  })

  test('records which changed files brought each persona in', () => {
    const { selected } = selectTeam(team, ['apps/web/Checkout.tsx', 'packages/ui/Button.tsx', 'README.md'])
    const guardian = selected.find(persona => persona.name === 'Design System Guardian')
    assert.deepEqual(guardian.matchedBy, ['apps/web/Checkout.tsx', 'packages/ui/Button.tsx'])
  })

  test('lists the changed files no scoped persona covers', () => {
    const { uncoveredFiles } = selectTeam(team, ['services/billing/invoice.ts', 'README.md', 'docs/setup.md'])
    assert.deepEqual(uncoveredFiles, ['README.md', 'docs/setup.md'])
  })

  // `path.matchesGlob` never lets `*` or `**` match a dot-segment, so without this rule a CI
  // workflow or a committed `.env` would silently fall outside every area persona's Scope.
  test('matches files under dot-directories and dotfiles, which bare path.matchesGlob skips', () => {
    const teamWithInfra = [...team, parsePersona(INFRA_REVIEWER)]
    const { selected, uncoveredFiles } = selectTeam(teamWithInfra, ['.github/workflows/ci.yml', 'infra/.env.prod'])
    const infra = selected.find(persona => persona.name === 'The Infra Reviewer')
    assert.deepEqual(infra?.matchedBy, ['.github/workflows/ci.yml', 'infra/.env.prod'])
    assert.deepEqual(uncoveredFiles, [])
  })

  test('selects core personas for a dotfile-only change', () => {
    assert.deepEqual(selectedNames(['.eslintrc.json']), ['The Architect'])
  })

  test('prints the panel line with each scoped persona and the file that brought it in', () => {
    const { selected } = selectTeam(team, ['services/a.ts', 'apps/web/A.tsx', 'apps/web/B.tsx'])
    assert.equal(
      formatPanel(selected),
      'Panel: core ×1 + The Backend Reviewer (services/a.ts) + Design System Guardian (apps/web/A.tsx, +1 more)',
    )
  })

  test('CLI prints the panel and selection for a team dir and files.txt', () => {
    const teamDir = makeTempDir('team')
    writeFiles(teamDir, { 'architect.md': ARCHITECT, 'backend.md': BACKEND_REVIEWER })
    const filesList = path.join(makeTempDir('run'), 'files.txt')
    fs.writeFileSync(filesList, 'services/a.ts\nREADME.md\n')
    const diffPath = path.join(path.dirname(filesList), 'diff.patch')
    fs.writeFileSync(diffPath, diffSection('services/a.ts', ['+x']) + diffSection('README.md', ['+y']))
    const result = runScript('node', [SELECT_TEAM, teamDir, filesList, diffPath])
    assert.equal(result.status, 0, result.stderr)
    const { panel, uncoveredFiles } = JSON.parse(result.stdout)
    assert.equal(panel, 'Panel: core ×1 + The Backend Reviewer (services/a.ts)')
    assert.deepEqual(uncoveredFiles, ['README.md'])
  })

  test('CLI fails with usage when the diff argument is missing', () => {
    const result = runScript('node', [SELECT_TEAM, makeTempDir('team'), '/tmp/files.txt'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /usage: select-team\.mjs <team-dir> <files\.txt> <diff\.patch>/)
  })

  test('CLI exits non-zero and names the changed-files list when it is missing', () => {
    const teamDir = makeTempDir('team')
    writeFiles(teamDir, { 'architect.md': ARCHITECT })
    const diffPath = path.join(makeTempDir('run'), 'diff.patch')
    fs.writeFileSync(diffPath, '')
    const result = runScript('node', [SELECT_TEAM, teamDir, '/nonexistent/files.txt', diffPath])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /files\.txt/)
  })
})

describe('select-team.mjs: Signals', () => {
  let selectTeam
  let parsePersona
  let parseChangedLines

  beforeEach(async () => {
    ;({ selectTeam } = await import(SELECT_TEAM))
    ;({ parsePersona } = await import(VALIDATE_TEAM))
    ;({ parseChangedLines } = await import(DIFF_LIB))
  })

  function selectFor(personaFiles, patchText) {
    const team = personaFiles.map(markdown => parsePersona(markdown))
    const changedLines = parseChangedLines(patchText)
    return selectTeam(team, [...changedLines.keys()], changedLines)
  }

  function guardianOf({ selected }) {
    return selected.find(persona => persona.name === 'The Design System Guardian')
  }

  const STYLE_OVERRIDE = '+  return <Button style={{ background: "red" }}>Pay</Button>'

  test('cross-boundary: an app overriding a design-system component brings the Guardian in, outside its Scope', () => {
    const selection = selectFor(
      [ARCHITECT, castGuardian('packages/ui/**')],
      diffSection('apps/web/src/Checkout.tsx', [STYLE_OVERRIDE]),
    )
    assert.deepEqual(guardianOf(selection)?.matchedBy, ['apps/web/src/Checkout.tsx'])
    assert.deepEqual(selection.uncoveredFiles, [])
  })

  test('direct: a change inside the design system still brings the Guardian in through its Scope', () => {
    const selection = selectFor(
      [ARCHITECT, castGuardian('packages/ui/**')],
      diffSection('packages/ui/src/Button.tsx', ['+  const padding = 8']),
    )
    assert.deepEqual(guardianOf(selection)?.matchedBy, ['packages/ui/src/Button.tsx'])
  })

  test('unrelated: a PR that neither touches the design system nor uses it leaves the Guardian out', () => {
    const selection = selectFor(
      [ARCHITECT, castGuardian('packages/ui/**')],
      diffSection('services/billing/invoice.ts', ['+  const total = items.reduce(sum, 0)']),
    )
    assert.equal(guardianOf(selection), undefined)
    assert.deepEqual(selection.selected.map(persona => persona.name), ['The Architect'])
  })

  test('different layouts: the same Signals catch the override wherever the design system lives', () => {
    for (const designSystemGlob of ['packages/ui/**', 'libs/components/**', 'src/shared/ds/**']) {
      const selection = selectFor(
        [ARCHITECT, castGuardian(designSystemGlob)],
        diffSection('web/pages/checkout.tsx', [STYLE_OVERRIDE]),
      )
      assert.deepEqual(guardianOf(selection)?.matchedBy, ['web/pages/checkout.tsx'], designSystemGlob)
    }
  })

  test('a newly added import of the design system counts as touching it', () => {
    const selection = selectFor(
      [ARCHITECT, castGuardian('packages/ui/**')],
      diffSection('apps/admin/Table.tsx', ["+import { Card } from '@acme/ui'"]),
    )
    assert.deepEqual(guardianOf(selection)?.matchedBy, ['apps/admin/Table.tsx'])
  })

  test('only changed lines count: an untouched import in the surrounding context does not', () => {
    const selection = selectFor(
      [ARCHITECT, castGuardian('packages/ui/**')],
      diffSection('apps/web/src/Checkout.tsx', [" import { Button } from '@acme/ui'", '+  const total = 3']),
    )
    assert.equal(guardianOf(selection), undefined)
  })

  test('a removed line counts too, so taking an override out still gets reviewed', () => {
    const selection = selectFor(
      [ARCHITECT, castGuardian('packages/ui/**')],
      diffSection('apps/web/src/Checkout.tsx', ['-  return <Button style={{ background: "red" }}>Pay</Button>']),
    )
    assert.deepEqual(guardianOf(selection)?.matchedBy, ['apps/web/src/Checkout.tsx'])
  })

  test('a deleted file is matched under its old path', () => {
    const selection = selectFor(
      [ARCHITECT, castGuardian('packages/ui/**')],
      diffSection('apps/web/src/Old.tsx', [STYLE_OVERRIDE.replace('+', '-')], { isDeleted: true }),
    )
    assert.deepEqual(guardianOf(selection)?.matchedBy, ['apps/web/src/Old.tsx'])
  })

  test('legacy: a persona with no Signals is selected by its Scope alone, exactly as before', () => {
    const selection = selectFor(
      [ARCHITECT, BACKEND_REVIEWER],
      diffSection('apps/web/src/Checkout.tsx', ['+  // services/billing is called from here']) +
        diffSection('services/a.ts', ['+  const x = 1']),
    )
    const backend = selection.selected.find(persona => persona.name === 'The Backend Reviewer')
    assert.deepEqual(backend.matchedBy, ['services/a.ts'])
  })

  test('lists each file once even when both its path and its lines match', () => {
    const selection = selectFor(
      [ARCHITECT, castGuardian('apps/**')],
      diffSection('apps/web/src/Checkout.tsx', [STYLE_OVERRIDE, STYLE_OVERRIDE]),
    )
    assert.deepEqual(guardianOf(selection)?.matchedBy, ['apps/web/src/Checkout.tsx'])
  })

  test('CLI reads the diff and selects by Signals', () => {
    const teamDir = makeTempDir('team')
    writeFiles(teamDir, { 'architect.md': ARCHITECT, 'design-system-guardian.md': castGuardian('packages/ui/**') })
    const runDir = makeTempDir('run')
    fs.writeFileSync(path.join(runDir, 'files.txt'), 'apps/web/src/Checkout.tsx\n')
    fs.writeFileSync(path.join(runDir, 'diff.patch'), diffSection('apps/web/src/Checkout.tsx', [STYLE_OVERRIDE]))
    const result = runScript('node', [SELECT_TEAM, teamDir, path.join(runDir, 'files.txt'), path.join(runDir, 'diff.patch')])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).panel, 'Panel: core ×1 + The Design System Guardian (apps/web/src/Checkout.tsx)')
  })

  test('CLI fails naming the diff when it cannot be read, rather than silently ignoring Signals', () => {
    const teamDir = makeTempDir('team')
    writeFiles(teamDir, { 'architect.md': ARCHITECT })
    const filesList = path.join(makeTempDir('run'), 'files.txt')
    fs.writeFileSync(filesList, 'a.ts\n')
    const result = runScript('node', [SELECT_TEAM, teamDir, filesList, '/nonexistent/diff.patch'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /diff\.patch/)
  })
})

describe('team-dir.mjs', () => {
  let teamHome

  beforeEach(() => {
    teamHome = makeTempDir('lens-review-home')
  })

  function teamDirFor(repoDir) {
    const result = runScript('node', [TEAM_DIR_SCRIPT, '--repo', repoDir], {
      env: { ...process.env, LENS_REVIEW_HOME: teamHome },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }

  test('gives the same repo the same team dir, under LENS_REVIEW_HOME', () => {
    const repoDir = makeGitRepo({ 'a.txt': '1\n' }, {})
    assert.equal(teamDirFor(repoDir), teamDirFor(repoDir))
    assert.ok(teamDirFor(repoDir).startsWith(path.join(teamHome, 'teams')))
  })

  test('gives two repos with different origin remotes different team dirs', () => {
    const firstRepo = makeGitRepo({ 'a.txt': '1\n' }, {})
    const secondRepo = makeGitRepo({ 'a.txt': '1\n' }, {})
    runScript('git', ['remote', 'add', 'origin', 'git@github.com:acme/web.git'], { cwd: firstRepo })
    runScript('git', ['remote', 'add', 'origin', 'git@github.com:acme/api.git'], { cwd: secondRepo })
    assert.notEqual(teamDirFor(firstRepo), teamDirFor(secondRepo))
  })

  test('gives the same remote the same team dir whether it is cloned over ssh or https', () => {
    const sshClone = makeGitRepo({ 'a.txt': '1\n' }, {})
    const httpsClone = makeGitRepo({ 'a.txt': '1\n' }, {})
    runScript('git', ['remote', 'add', 'origin', 'git@github.com:acme/web.git'], { cwd: sshClone })
    runScript('git', ['remote', 'add', 'origin', 'https://github.com/acme/web'], { cwd: httpsClone })
    assert.equal(teamDirFor(sshClone), teamDirFor(httpsClone))
  })

  test('gives two same-named checkouts without a remote different team dirs', () => {
    const firstRepo = path.join(makeGitRepo({ 'a.txt': '1\n' }, {}), 'app')
    const secondRepo = path.join(makeGitRepo({ 'a.txt': '1\n' }, {}), 'app')
    for (const repoDir of [firstRepo, secondRepo]) {
      fs.mkdirSync(repoDir)
      runScript('git', ['init', '-q'], { cwd: repoDir })
    }
    assert.notEqual(teamDirFor(firstRepo), teamDirFor(secondRepo))
  })

  test('CLI exits non-zero and names the path when --repo is not a git repository', () => {
    const notARepo = makeTempDir('not-a-repo')
    const result = runScript('node', [TEAM_DIR_SCRIPT, '--repo', notARepo], {
      env: { ...process.env, LENS_REVIEW_HOME: teamHome },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /not-a-repo/)
  })
})

describe('parse-reply.mjs', () => {
  let replyDir

  beforeEach(() => {
    replyDir = makeTempDir('agent-reply')
  })

  function parseReply(replyText, flags = []) {
    const replyPath = path.join(replyDir, 'reply.txt')
    const outPath = path.join(replyDir, 'findings.json')
    fs.writeFileSync(replyPath, replyText)
    const result = runScript('node', [PARSE_REPLY, replyPath, outPath, ...flags])
    return { result, outPath }
  }

  test('writes a bare JSON reply through unchanged', () => {
    const { result, outPath } = parseReply('[{"id": "F1", "verdict": "keep"}]')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), [{ id: 'F1', verdict: 'keep' }])
  })

  test('strips one code fence wrapped around the whole reply, every run, not at the caller\'s discretion', () => {
    for (const fenced of ['```json\n[{"file": "src/a.ts"}]\n```', '\n```\n{"persona": "X", "votes": []}\n```\n']) {
      const { result, outPath } = parseReply(fenced)
      assert.equal(result.status, 0, result.stderr)
      assert.ok(JSON.parse(fs.readFileSync(outPath, 'utf8')))
    }
  })

  test('--default-reviewer credits a finding with no reviewer to the agent that wrote the reply', () => {
    // The Maintainer's reply in the carpool #13 run: valid findings, no `reviewer` on any of them.
    const reply = JSON.stringify([
      { file: 'README.md', line: 188, severity: 'should', category: 'maintainability', description: 'The runbook misdescribes the seed refusal.' },
      { file: 'e2e/a.spec.ts', line: 160, severity: 'suggestion', category: 'maintainability', description: 'Misleading name.', reviewer: 'The Architect' },
    ])
    const { result, outPath } = parseReply(reply, ['--default-reviewer', 'The Maintainer'])
    assert.equal(result.status, 0, result.stderr)
    const findings = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    assert.deepEqual(findings.map(written => written.reviewer), ['The Maintainer', 'The Architect'])
  })

  test('--default-reviewer refuses a reply that is not a findings array, so the agent counts as failed', () => {
    const { result, outPath } = parseReply('{"persona": "X", "votes": []}', ['--default-reviewer', 'The Maintainer'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /reply\.txt is not a JSON array of findings/)
    assert.ok(!fs.existsSync(outPath))
  })

  test('--default-reviewer without a name fails with usage', () => {
    const { result } = parseReply('[]', ['--default-reviewer'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /needs a name/)
  })

  test('fails loudly, naming the reply, and writes nothing when the reply is not JSON', () => {
    for (const notJson of ['Here are my findings:\n```json\n[]\n```', 'I found no issues.', '```json\n[{"file": \n```']) {
      const { result, outPath } = parseReply(notJson)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /reply\.txt/)
      assert.ok(!fs.existsSync(outPath))
    }
  })
})

describe('build-pr-review.mjs', () => {
  const HEAD_SHA = 'a'.repeat(40)
  const SUMMARY = '## Lens Review: feature\n\n**Summary:** Adds the checkout API.'
  let buildPrReview
  let diffLines
  let inputDir

  beforeEach(async () => {
    let parseDiffLines
    ;({ buildPrReview } = await import(BUILD_PR_REVIEW))
    ;({ parseDiffLines } = await import(MERGE_FINDINGS))
    diffLines = parseDiffLines(DIFF_PATCH)
    inputDir = makeTempDir('pr-review')
    fs.writeFileSync(path.join(inputDir, 'diff.patch'), DIFF_PATCH)
    fs.writeFileSync(path.join(inputDir, 'summary.md'), SUMMARY)
    fs.writeFileSync(path.join(inputDir, 'final-findings.json'), '[]')
  })

  function finalFinding(overrides) {
    const { reviewer, ...issue } = finding(overrides)
    return { id: 'F1', ...issue, reviewers: [reviewer] }
  }

  function runBuild(findings) {
    const findingsPath = path.join(inputDir, 'final-findings.json')
    fs.writeFileSync(findingsPath, JSON.stringify(findings))
    return runScript('node', [
      BUILD_PR_REVIEW,
      '--findings', findingsPath,
      '--diff', path.join(inputDir, 'diff.patch'),
      '--summary', path.join(inputDir, 'summary.md'),
      '--commit', HEAD_SHA,
    ])
  }

  test('always posts as a plain COMMENT review on the head commit, never an approval or a block', () => {
    const review = buildPrReview({ findings: [finalFinding()], diffLines, summary: SUMMARY, commitId: HEAD_SHA })
    assert.equal(review.event, 'COMMENT')
    assert.equal(review.commit_id, HEAD_SHA)
  })

  test('puts a finding on a changed line inline, on the new side, with its severity, category and rule', () => {
    const review = buildPrReview({
      findings: [finalFinding({ severity: 'must', line: 12 })],
      diffLines,
      summary: SUMMARY,
      commitId: HEAD_SHA,
    })
    assert.equal(review.comments.length, 1)
    const [comment] = review.comments
    assert.deepEqual({ path: comment.path, line: comment.line, side: comment.side }, { path: 'src/api.ts', line: 12, side: 'RIGHT' })
    assert.match(comment.body, /^\*\*Must fix\*\* · correctness/)
    assert.match(comment.body, /Missing await on save\(\)/)
    assert.match(comment.body, /Async operations are awaited/)
  })

  test('names the existing code a duplication finding points at', () => {
    const review = buildPrReview({
      findings: [finalFinding({ category: 'duplication', duplicates: 'src/utils/money.ts:4' })],
      diffLines,
      summary: SUMMARY,
      commitId: HEAD_SHA,
    })
    assert.match(review.comments[0].body, /Duplicates `src\/utils\/money\.ts:4`/)
  })

  test('posts a merged duplication once, listing every copy it stands for', () => {
    const locations = [
      { file: 'src/api.ts', line: 10, duplicates: 'src/utils/money.ts:4', description: 'formatMoney copy' },
      { file: 'src/components/Checkout.tsx', line: 3, description: 'Another formatMoney copy' },
    ]
    const review = buildPrReview({
      findings: [finalFinding({ category: 'duplication', duplicates: 'src/utils/money.ts:4', locations })],
      diffLines,
      summary: SUMMARY,
      commitId: HEAD_SHA,
    })
    assert.equal(review.comments.length, 1)
    assert.match(review.comments[0].body, /Every copy:\n- `src\/api\.ts:10` \(duplicates `src\/utils\/money\.ts:4`\)\n- `src\/components\/Checkout\.tsx:3`/)
  })

  test('keeps reviewer names off the PR', () => {
    const review = buildPrReview({ findings: [finalFinding({ reviewer: 'The Reuse Scout' })], diffLines, summary: SUMMARY, commitId: HEAD_SHA })
    assert.doesNotMatch(JSON.stringify(review), /Reuse Scout/)
  })

  test('moves a finding GitHub cannot anchor (outside the PR diff) into the review body instead of dropping it', () => {
    const review = buildPrReview({
      findings: [finalFinding({ id: 'F1', line: 12 }), finalFinding({ id: 'F2', line: 200, description: 'Stale cache key' })],
      diffLines,
      summary: SUMMARY,
      commitId: HEAD_SHA,
    })
    assert.equal(review.comments.length, 1)
    assert.match(review.body, /Not on a changed line/)
    assert.match(review.body, /Stale cache key — `src\/api\.ts:200`/)
  })

  test('opens the body with the summary and tags it, so a later run can tell it posted before', async () => {
    const { REVIEW_MARKER } = await import(BUILD_PR_REVIEW)
    const review = buildPrReview({ findings: [], diffLines, summary: SUMMARY, commitId: HEAD_SHA })
    assert.ok(review.body.startsWith(SUMMARY))
    assert.ok(review.body.includes(REVIEW_MARKER))
    assert.deepEqual(review.comments, [])
  })

  test('prints the payload and says how many findings went inline vs into the body', () => {
    const result = runBuild([finalFinding({ id: 'F1', line: 12 }), finalFinding({ id: 'F2', line: 200 })])
    assert.equal(result.status, 0, result.stderr)
    const review = JSON.parse(result.stdout)
    assert.equal(review.comments.length, 1)
    assert.match(result.stderr, /1 inline, 1 in the review body/)
  })

  test('fails loudly on a finding it cannot render, naming it, rather than posting a partial review', () => {
    const result = runBuild([finalFinding({ id: 'F7', severity: 'critical' })])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /F7/)
    assert.equal(result.stdout, '')
  })

  test('refuses a commit that is not a full SHA, since GitHub would anchor the comments to the wrong code', () => {
    const result = runScript('node', [
      BUILD_PR_REVIEW,
      '--findings', path.join(inputDir, 'final-findings.json'),
      '--diff', path.join(inputDir, 'diff.patch'),
      '--summary', path.join(inputDir, 'summary.md'),
      '--commit', 'main',
    ])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--commit/)
  })

  test('fails with usage when a required flag is missing', () => {
    const result = runScript('node', [BUILD_PR_REVIEW, '--findings', path.join(inputDir, 'final-findings.json')])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /usage: build-pr-review\.mjs/)
  })

  test('fails naming the file when an input cannot be read', () => {
    const result = runScript('node', [
      BUILD_PR_REVIEW,
      '--findings', path.join(inputDir, 'final-findings.json'),
      '--diff', path.join(inputDir, 'diff.patch'),
      '--summary', path.join(inputDir, 'missing.md'),
      '--commit', HEAD_SHA,
    ])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /missing\.md/)
  })
})

describe('collect-findings.mjs', () => {
  const COLLECT_FINDINGS = path.join(SCRIPTS_DIR, 'collect-findings.mjs')
  let runDir

  beforeEach(() => {
    runDir = makeTempDir('collect-findings')
    fs.writeFileSync(path.join(runDir, 'diff.patch'), DIFF_PATCH)
  })

  function collect(...agentArgs) {
    return runScript('node', [COLLECT_FINDINGS, runDir, ...agentArgs])
  }

  test('parses every reply, credits a finding with no reviewer to its agent, and merges them in one call', () => {
    const { reviewer, ...withoutReviewer } = finding({ line: 40 })
    fs.writeFileSync(path.join(runDir, 'reply-anthropic.txt'), JSON.stringify([finding({ reviewer: 'Anthropic' })]))
    fs.writeFileSync(path.join(runDir, 'reply-maintainer.txt'), '```json\n' + JSON.stringify([withoutReviewer]) + '\n```')
    const result = collect('anthropic=Anthropic', 'maintainer=The Maintainer')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { failedReviewers: [], droppedFindings: 0, prechecks: 0, findings: 2 })
    const merged = JSON.parse(fs.readFileSync(path.join(runDir, 'merged.json'), 'utf8'))
    assert.deepEqual(merged.map(written => written.reviewers), [['Anthropic'], ['The Maintainer']])
    assert.ok(fs.existsSync(path.join(runDir, 'findings-maintainer.json')))
  })

  test('lists a reviewer whose reply is missing or not a findings array as failed, and merges the rest', () => {
    fs.writeFileSync(path.join(runDir, 'reply-anthropic.txt'), JSON.stringify([finding({ reviewer: 'Anthropic' })]))
    fs.writeFileSync(path.join(runDir, 'reply-architect.txt'), 'I found no issues.')
    const result = collect('anthropic=Anthropic', 'architect=The Architect', 'reuse-scout=The Reuse Scout')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).failedReviewers, ['The Architect', 'The Reuse Scout'])
    assert.match(result.stderr, /failed reviewer: .*reply-reuse-scout\.txt/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'merged.json'), 'utf8')).length, 1)
  })

  test('merges the precheck findings in precheck.json like any reviewer\'s, credited to Precheck', () => {
    fs.writeFileSync(path.join(runDir, 'reply-anthropic.txt'), JSON.stringify([finding({ reviewer: 'Anthropic' })]))
    const precheckFinding = { ...finding({ line: 40, category: 'tests', reviewer: 'Precheck' }), check: 'untested-failure-path' }
    fs.writeFileSync(path.join(runDir, 'precheck.json'), JSON.stringify([precheckFinding]))
    const result = collect('anthropic=Anthropic')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).prechecks, 1)
    const merged = JSON.parse(fs.readFileSync(path.join(runDir, 'merged.json'), 'utf8'))
    const fromPrecheck = merged.find(written => written.reviewers.includes('Precheck'))
    assert.equal(fromPrecheck.check, 'untested-failure-path')
  })

  test('lists Precheck as a failed reviewer when precheck.json is not a findings array, and merges the rest', () => {
    fs.writeFileSync(path.join(runDir, 'reply-anthropic.txt'), JSON.stringify([finding({ reviewer: 'Anthropic' })]))
    fs.writeFileSync(path.join(runDir, 'precheck.json'), '{"not": "an array"}')
    const result = collect('anthropic=Anthropic')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).failedReviewers, ['Precheck'])
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'merged.json'), 'utf8')).length, 1)
  })

  test('still drops a finding outside the diff, and counts it', () => {
    fs.writeFileSync(path.join(runDir, 'reply-anthropic.txt'), JSON.stringify([finding({ file: 'src/untouched.ts' })]))
    const result = collect('anthropic=Anthropic')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).droppedFindings, 1)
  })

  test('fails with usage on an agent argument that is not <stem>=<reviewer>', () => {
    const result = collect('anthropic')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /"anthropic" is not <stem>=<reviewer name>/)
  })

  test('fails naming the diff when the run dir has none', () => {
    fs.rmSync(path.join(runDir, 'diff.patch'))
    const result = collect('anthropic=Anthropic')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /diff\.patch/)
  })
})

describe('collect-votes.mjs', () => {
  const COLLECT_VOTES = path.join(SCRIPTS_DIR, 'collect-votes.mjs')
  let runDir

  beforeEach(() => {
    runDir = makeTempDir('collect-votes')
    const { reviewer, ...issue } = finding({})
    fs.writeFileSync(path.join(runDir, 'merged.json'), JSON.stringify([{ id: 'F1', ...issue, reviewers: [reviewer] }]))
  })

  test('parses every ballot and tallies them into tallied.json in one call', () => {
    fs.writeFileSync(path.join(runDir, 'reply-votes-architect.txt'), JSON.stringify({ persona: 'The Architect', votes: [{ id: 'F1', verdict: 'dispute', reason: 'Awaited upstream' }] }))
    const result = runScript('node', [COLLECT_VOTES, runDir, 'architect'])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { voted: 1, failedVoters: [], contested: 1, droppedVotes: 0 })
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'tallied.json'), 'utf8'))[0].contested, true)
  })

  test('counts a persona with no ballot file as a failed voter and tallies the rest', () => {
    const result = runScript('node', [COLLECT_VOTES, runDir, 'architect'])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).failedVoters, ['architect'])
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'tallied.json'), 'utf8'))[0].contested, false)
  })

  test('fails naming merged.json when it is missing', () => {
    fs.rmSync(path.join(runDir, 'merged.json'))
    const result = runScript('node', [COLLECT_VOTES, runDir])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /merged\.json/)
  })
})

describe('apply-skeptic.mjs', () => {
  const APPLY_SKEPTIC = path.join(SCRIPTS_DIR, 'apply-skeptic.mjs')
  let runDir

  beforeEach(() => {
    runDir = makeTempDir('apply-skeptic')
    const { reviewer, ...issue } = finding({})
    const tallied = ['F1', 'F2'].map(id => ({ id, ...issue, reviewers: [reviewer], challenge: { agree: [], dispute: [] }, contested: false }))
    fs.writeFileSync(path.join(runDir, 'tallied.json'), JSON.stringify(tallied))
  })

  function applySkeptic(reply) {
    if (reply !== undefined) fs.writeFileSync(path.join(runDir, 'reply-skeptic.txt'), reply)
    return runScript('node', [APPLY_SKEPTIC, runDir])
  }

  test('keeps only the findings the skeptic kept, unchanged, with its ruling attached', () => {
    const result = applySkeptic(JSON.stringify([
      { id: 'F1', verdict: 'keep', reason: 'Line 10 drops the promise.' },
      { id: 'F2', verdict: 'drop', reason: 'Awaited by the caller.' },
    ]))
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { kept: 1, dropped: 1 })
    const [kept, ...rest] = JSON.parse(fs.readFileSync(path.join(runDir, 'final-findings.json'), 'utf8'))
    assert.deepEqual(rest, [])
    assert.equal(kept.id, 'F1')
    assert.deepEqual(kept.skeptic, { verdict: 'keep', reason: 'Line 10 drops the promise.' })
    assert.deepEqual(kept.challenge, { agree: [], dispute: [] })
  })

  test('fails naming every id the skeptic did not rule on, and writes no final findings', () => {
    const result = applySkeptic(JSON.stringify([{ id: 'F1', verdict: 'maybe', reason: '?' }]))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /no keep\/drop verdict for F1, F2/)
    assert.ok(!fs.existsSync(path.join(runDir, 'final-findings.json')))
  })

  test('fails naming the reply when the skeptic wrote none', () => {
    const result = applySkeptic()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /reply-skeptic\.txt/)
  })

  test('with no findings to rule on, writes an empty review without needing a skeptic reply', () => {
    fs.writeFileSync(path.join(runDir, 'tallied.json'), '[]')
    const result = applySkeptic()
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'final-findings.json'), 'utf8')), [])
  })
})

describe('discover-plan-docs.mjs', () => {
  const DISCOVER_PLAN_DOCS = path.join(SCRIPTS_DIR, 'discover-plan-docs.mjs')
  let inputDir
  let filesPath

  beforeEach(() => {
    inputDir = makeTempDir('plan-docs')
    filesPath = path.join(inputDir, 'files.txt')
    fs.writeFileSync(
      filesPath,
      ['docs/tech-design-names-parents-seats.md', 'supabase/migrations/20261024000001_standing_drives.sql', 'README.md', 'src/plan.ts', 'tasks/x/INTENT.md'].join('\n'),
    )
  })

  test('finds the plan and intent docs the PR changes, and nothing else, as the PR\'s own', () => {
    const result = runScript('node', [DISCOVER_PLAN_DOCS, '--files', filesPath])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { passed: [], fromPr: ['docs/tech-design-names-parents-seats.md', 'tasks/x/INTENT.md'] })
  })

  test('lists a plan the caller passes apart from the PR\'s own, once each', () => {
    const passedPlan = path.join(inputDir, 'tech-design.md')
    fs.writeFileSync(passedPlan, '# Plan\n')
    const result = runScript('node', [DISCOVER_PLAN_DOCS, '--files', filesPath, '--plan', passedPlan, '--plan', passedPlan])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { passed: [passedPlan], fromPr: ['docs/tech-design-names-parents-seats.md', 'tasks/x/INTENT.md'] })
  })

  test('a passed plan the PR itself changes stays the PR\'s own: passing it does not vouch for the PR\'s edits', () => {
    const repoDir = makeTempDir('plan-repo')
    writeFiles(repoDir, { 'docs/tech-design-names-parents-seats.md': '# Plan\n' })
    const result = runScript('node', [DISCOVER_PLAN_DOCS, '--files', filesPath, '--plan', 'docs/tech-design-names-parents-seats.md'], { cwd: repoDir })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).passed, [])
    assert.ok(JSON.parse(result.stdout).fromPr.includes('docs/tech-design-names-parents-seats.md'))
  })

  test('returns no plan docs for a PR that changes none', () => {
    fs.writeFileSync(filesPath, 'src/a.ts\n')
    const result = runScript('node', [DISCOVER_PLAN_DOCS, '--files', filesPath])
    assert.deepEqual(JSON.parse(result.stdout), { passed: [], fromPr: [] })
  })

  test('fails naming a passed plan that does not exist, rather than reviewing without it', () => {
    const result = runScript('node', [DISCOVER_PLAN_DOCS, '--files', filesPath, '--plan', '/nonexistent/tech-design.md'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /plan doc not found: \/nonexistent\/tech-design\.md/)
  })

  test('fails with usage when --files is missing', () => {
    const result = runScript('node', [DISCOVER_PLAN_DOCS])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /usage: discover-plan-docs\.mjs/)
  })
})
