// Deterministic pre-checks: candidate findings a script can find for sure, so they don't
// depend on whether a Haiku reviewer happens to notice them this run. Each check is one
// function in prechecks/; their findings are credited to "Precheck", name their `check`, and
// join the merge like any reviewer's, so the challenge round and the skeptic still rule on them.
//
//   node precheck.mjs <run-dir> [--repo <dir>] [--plan <path>]...
//     reads <run-dir>/diff.patch, head.txt (the commit to read the repo at; required) and
//     base-tip.txt (the base branch now, for migrations merged since the branch was cut),
//     writes precheck.json → {findings, byCheck, failedChecks, ms} on stdout
import fs from 'node:fs'
import path from 'node:path'
import { fail, isRunDirectly, readTextFile } from './lib/cli.mjs'
import { parseDiffFiles } from './lib/diff.mjs'
import { openRepo } from './lib/repo.mjs'
import { currentVariant } from './lib/variant.mjs'
import { writeJson } from './parse-reply.mjs'
import { isPlanDoc } from './discover-plan-docs.mjs'
import { untestedFailurePath } from './prechecks/untested-failure-path.mjs'
import { duplicateInDiff } from './prechecks/duplicate-in-diff.mjs'
import { newlyUnused } from './prechecks/newly-unused.mjs'
import { migrationOrder } from './prechecks/migration-order.mjs'
import { uncheckedField } from './prechecks/unchecked-field.mjs'
import { undeclaredDependency } from './prechecks/undeclared-dependency.mjs'

export const CHECKS = {
  'untested-failure-path': untestedFailurePath,
  'duplicate-in-diff': duplicateInDiff,
  'newly-unused': newlyUnused,
  'migration-order': migrationOrder,
  'unchecked-field': uncheckedField,
  'undeclared-dependency': undeclaredDependency,
}

// A check that throws is reported and skipped: one broken heuristic must not cost the review
// the other checks, or the reviewers' findings.
export function runPrechecks(change, checks = CHECKS) {
  const findings = []
  const failedChecks = []
  for (const [name, check] of Object.entries(checks)) {
    try {
      findings.push(...check(change))
    } catch (error) {
      failedChecks.push({ check: name, reason: error.message })
    }
  }
  return { findings, failedChecks }
}

function readOptional(filePath) {
  return fs.existsSync(filePath) ? readTextFile(filePath).trim() : null
}

function parseArgs(argv) {
  const [runDir, ...rest] = argv
  const options = { runDir, repoDir: '.', passedPlans: [] }
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === '--repo') options.repoDir = rest[++index]
    else if (rest[index] === '--plan') options.passedPlans.push(rest[++index])
    else fail(`unknown argument: ${rest[index]}`)
  }
  return options
}

if (isRunDirectly(import.meta.url)) {
  const startedAt = Date.now()
  const { runDir, repoDir, passedPlans } = parseArgs(process.argv.slice(2))
  if (!runDir || runDir.startsWith('--')) fail('usage: precheck.mjs <run-dir> [--repo <dir>] [--plan <path>]...')
  const diffPatch = readTextFile(path.join(runDir, 'diff.patch'))
  let variant
  try {
    variant = currentVariant()
  } catch (error) {
    fail(error.message)
  }
  if (!variant.prechecks) {
    // An empty precheck.json keeps every later step the same; only the findings are missing.
    writeJson(path.join(runDir, 'precheck.json'), [])
    console.log(JSON.stringify({ findings: 0, byCheck: {}, failedChecks: [], skipped: `variant ${variant.name} runs without prechecks` }))
    process.exit(0)
  }
  const diffFiles = parseDiffFiles(diffPatch)
  const head = readOptional(path.join(runDir, 'head.txt'))
  if (!head) fail(`${path.join(runDir, 'head.txt')} is missing or empty: write it before running the prechecks`)
  const baseTip = readOptional(path.join(runDir, 'base-tip.txt'))
  if (!baseTip) console.error(`lens-review: no base-tip.txt in ${runDir}; migration-order sees only the migrations at the head`)
  let repo
  let baseTipFiles
  try {
    repo = openRepo(repoDir, head)
    baseTipFiles = baseTip ? repo.filesAt(baseTip) : []
  } catch (error) {
    fail(error.message)
  }
  const changedPlanDocs = diffFiles.map(file => file.path).filter(isPlanDoc)
  const planDocs = [
    ...passedPlans.map(planPath => ({ path: planPath, text: readTextFile(planPath) })),
    ...changedPlanDocs.map(planPath => ({ path: planPath, text: repo.read(planPath) ?? '' })),
  ]
  const { findings, failedChecks } = runPrechecks({ diffFiles, repo, planDocs, baseTipFiles })
  for (const { check, reason } of failedChecks) console.error(`lens-review: precheck ${check} failed: ${reason}`)
  writeJson(path.join(runDir, 'precheck.json'), findings)
  const byCheck = {}
  for (const { check } of findings) byCheck[check] = (byCheck[check] ?? 0) + 1
  console.log(JSON.stringify({ findings: findings.length, byCheck, failedChecks: failedChecks.map(({ check }) => check), ms: Date.now() - startedAt }))
}
