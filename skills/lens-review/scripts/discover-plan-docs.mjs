// Finds the plan or intent docs for the work a PR implements: the ones the PR itself adds or
// changes (a plan usually ships on the branch that carries it out), plus any the caller
// passes with --plan. Only those, not every design doc in the repo: a plan for some other
// feature would only spend the reviewers' context. A reviewer without the plan can't tell
// that this PR overtakes a sibling milestone, or that it does exactly what the plan asked.
//
// The two kinds are kept apart because only one can be trusted: a passed plan was approved
// outside the PR, while the PR's own plan docs are written by its author and are unverified.
// A passed plan the PR itself edits counts as the PR's own.
//
//   node discover-plan-docs.mjs --files <files.txt> [--plan <path>]...
//     → {passed: [paths], fromPr: [paths]} on stdout
import fs from 'node:fs'
import path from 'node:path'
import { fail, isRunDirectly, readTextFile } from './lib/cli.mjs'

const PLAN_DOC_RE = /(^|\/)(intent|tech-design[\w.-]*|design[\w.-]*|plan[\w.-]*|spec[\w.-]*)\.md$/i

export function isPlanDoc(file) {
  return PLAN_DOC_RE.test(file)
}

function isChangedByPr(plan, changedFiles) {
  return changedFiles.includes(path.relative(process.cwd(), path.resolve(plan)).split(path.sep).join('/'))
}

export function discoverPlanDocs(changedFiles, passedPlans) {
  const editedPassedPlans = passedPlans.filter(plan => isChangedByPr(plan, changedFiles))
  return {
    passed: [...new Set(passedPlans.filter(plan => !editedPassedPlans.includes(plan)))],
    fromPr: [...new Set([...changedFiles.filter(isPlanDoc), ...editedPassedPlans.map(plan => path.relative(process.cwd(), path.resolve(plan)))])],
  }
}

function parseArgs(argv) {
  const passedPlans = []
  let filesPath = null
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--files') filesPath = argv[++index]
    else if (argv[index] === '--plan') passedPlans.push(argv[++index])
    else fail(`unknown argument: ${argv[index]}`)
  }
  return { filesPath, passedPlans }
}

if (isRunDirectly(import.meta.url)) {
  const { filesPath, passedPlans } = parseArgs(process.argv.slice(2))
  if (!filesPath) fail('usage: discover-plan-docs.mjs --files <files.txt> [--plan <path>]...')
  const missingPlan = passedPlans.find(plan => !plan || !fs.existsSync(plan))
  if (missingPlan !== undefined) fail(`plan doc not found: ${missingPlan}`)
  const changedFiles = readTextFile(filesPath).split('\n').filter(Boolean)
  console.log(JSON.stringify(discoverPlanDocs(changedFiles, passedPlans), null, 2))
}
