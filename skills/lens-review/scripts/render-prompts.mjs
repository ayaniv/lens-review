// Renders every agent's full prompt to a file, so the orchestrator's Agent call (or
// SendMessage) is one line pointing at it. Writing a ~6k-character persona prompt per agent
// was most of the orchestrator's output, its wall time and its cost; a script fills the
// templates the same way every run.
//
//   node render-prompts.mjs <run-dir> <team-dir> [--phase review|challenge|skeptic]
//     review (default): prompt-anthropic.txt and prompt-<stem>.txt per selected persona
//       (plus prompt-deep-pass.txt when the variant has a deep pass)
//       → {agents: [{stem, reviewer, model, promptPath}], collectArgs, challengeRound, variant} on stdout
//     challenge: prompt-votes-<stem>.txt per selected persona → {voters: [{stem, reviewer, promptPath}]}
//     skeptic: prompt-skeptic.txt → {model, promptPath}
//   reads <run-dir>/pr-context.txt, rule-sources.json, plan-docs.json, panel.json, and
//   merged.json (challenge) or tallied.json (skeptic)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail, isRunDirectly, readJsonArrayFile, readJsonFile, readTextFile } from './lib/cli.mjs'
import { DEEP_PASS_MODEL, currentVariant } from './lib/variant.mjs'

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// One shared vocabulary is what lets the merge recognise two reviewers' findings as one issue.
export const CATEGORIES = [
  'security',
  'correctness',
  'reliability',
  'performance',
  'architecture',
  'maintainability',
  'duplication',
  'design-system',
  'data',
  'infra',
  'domain',
  'tests',
]
export const REVIEWER_MODEL = 'haiku'
export const SKEPTIC_MODEL = 'opus'
const GENERAL_REVIEWER = { stem: 'anthropic', reviewer: 'Anthropic' }
const DEEP_PASS_REVIEWER = { stem: 'deep-pass', reviewer: 'Deep Pass' }
const CHECKLIST_PERSONA = 'maintainer.md'
// The two personas whose findings depend on what the plan says.
const PLAN_READING_PERSONAS = ['domain-expert.md', 'data-steward.md']

function template(fileName) {
  return readTextFile(path.join(SKILL_DIR, fileName))
}

// Every <<<KEY>>> from `values`, and <RUN_DIR>, in one pass over the template: a value that
// itself holds placeholder-looking text (a PR about this skill, a finding quoting a prompt)
// is never rescanned, and a replacement function keeps a `$` in a value literal.
function fill(text, runDir, values) {
  return text.replace(/<<<([A-Z_]+)>>>|<RUN_DIR>/g, (placeholder, key) => {
    if (!key) return runDir
    if (!(key in values)) throw new Error(`template placeholder ${placeholder} has no value`)
    return values[key]
  })
}

function readPlanDocs(runDir) {
  const planDocs = readJsonFile(path.join(runDir, 'plan-docs.json'))
  if (!Array.isArray(planDocs?.passed) || !Array.isArray(planDocs?.fromPr)) {
    fail(`${path.join(runDir, 'plan-docs.json')} must be {passed: [...], fromPr: [...]}`)
  }
  return planDocs
}

function readSelected(runDir) {
  const selected = readJsonFile(path.join(runDir, 'panel.json'))?.selected
  if (!Array.isArray(selected)) fail(`${path.join(runDir, 'panel.json')} has no selected array`)
  return selected
}

function planNote({ passed, fromPr }) {
  if (passed.length + fromPr.length === 0) return ''
  const lines = [...passed.map(doc => `${doc} (passed by the caller)`), ...fromPr.map(doc => `${doc} (added in this PR, unverified)`)]
  return [
    '',
    'PLAN DOCS (the plan or intent this PR implements; read them):',
    ...lines,
    'Check the PR against them: what its part of the plan requires, and what the plan has shipping before or alongside it (sibling milestones, their migrations, flags) that this PR could collide with or overtake.',
  ].join('\n')
}

function reviewPrompts(runDir, teamDir, variant) {
  const prContext = readTextFile(path.join(runDir, 'pr-context.txt')).trim()
  const ruleSourcePaths = readJsonArrayFile(path.join(runDir, 'rule-sources.json')).map(source => source.path).join('\n') || 'none'
  const planDocs = readPlanDocs(runDir)
  const selected = readSelected(runDir)
  const categories = CATEGORIES.join(', ')
  const wholeDiffReviewer = ({ stem, reviewer }, templateName, model) => ({
    stem,
    reviewer,
    model,
    text: fill(template(templateName), runDir, {
      PR_TITLE_AND_DESCRIPTION: prContext,
      CATEGORIES: categories,
      REPLY_FILE: path.join(runDir, `reply-${stem}.txt`),
    }),
  })
  const general = wholeDiffReviewer(GENERAL_REVIEWER, 'reviewer-general-prompt.md', variant.generalModel)
  const deepPass = variant.deepPass ? [wholeDiffReviewer(DEEP_PASS_REVIEWER, 'reviewer-deep-pass-prompt.md', DEEP_PASS_MODEL)] : []
  const personaTemplate = template('reviewer-persona-prompt.md')
  const checklist = template('checklist.md').trim()
  const personas = selected.map(({ file, name, matchedBy = [] }) => {
    const stem = path.basename(file, '.md')
    const text = fill(personaTemplate, runDir, {
      PERSONA_NAME: name,
      PERSONA_FILE: readTextFile(path.join(teamDir, file)).trim(),
      SCOPE_NOTE: matchedBy.length > 0 ? ` (these: ${matchedBy.join(', ')})` : '',
      PR_TITLE_AND_DESCRIPTION: prContext,
      RULE_SOURCE_PATHS: ruleSourcePaths,
      PLAN_NOTE: PLAN_READING_PERSONAS.includes(file) ? planNote(planDocs) : '',
      CATEGORIES: categories,
      REPLY_FILE: path.join(runDir, `reply-${stem}.txt`),
    })
    return {
      stem,
      reviewer: name,
      model: REVIEWER_MODEL,
      text: file === CHECKLIST_PERSONA ? `${text.trimEnd()}\n\nCHECKLIST:\n${checklist}\n` : text,
    }
  })
  return [general, ...deepPass, ...personas]
}

function challengePrompts(runDir) {
  const mergedFindings = JSON.stringify(readJsonArrayFile(path.join(runDir, 'merged.json')), null, 2)
  const challengeTemplate = template('challenge-prompt.md')
  return readSelected(runDir).map(({ file, name }) => {
    const stem = path.basename(file, '.md')
    return {
      stem: `votes-${stem}`,
      voter: stem,
      reviewer: name,
      text: fill(challengeTemplate, runDir, { MERGED_FINDINGS: mergedFindings, REPLY_FILE: path.join(runDir, `reply-votes-${stem}.txt`) }),
    }
  })
}

function listOrNone(paths) {
  return paths.length > 0 ? paths.join('\n') : 'none'
}

function skepticPrompt(runDir) {
  const { passed, fromPr } = readPlanDocs(runDir)
  const text = fill(template('skeptic-prompt.md'), runDir, {
    APPROVED_PLAN_DOCS: listOrNone(passed),
    UNVERIFIED_PLAN_DOCS: listOrNone(fromPr),
    TALLIED_FINDINGS_JSON: JSON.stringify(readJsonArrayFile(path.join(runDir, 'tallied.json')), null, 2),
    REPLY_FILE: path.join(runDir, 'reply-skeptic.txt'),
  })
  return { stem: 'skeptic', text }
}

function promptPath(runDir, stem) {
  return path.join(runDir, `prompt-${stem}.txt`)
}

// Every prompt is built before any is written, so a bad input never leaves half a set behind.
function writePrompts(runDir, prompts) {
  for (const { stem, text } of prompts) fs.writeFileSync(promptPath(runDir, stem), text)
}

function render(phase, runDir, teamDir) {
  const variant = currentVariant()
  switch (phase) {
    case 'review': {
      const prompts = reviewPrompts(runDir, teamDir, variant)
      writePrompts(runDir, prompts)
      return {
        agents: prompts.map(({ stem, reviewer, model }) => ({ stem, reviewer, model, promptPath: promptPath(runDir, stem) })),
        collectArgs: prompts.map(({ stem, reviewer }) => `${stem}=${reviewer}`),
        challengeRound: variant.challengeRound,
        variant: variant.name,
      }
    }
    case 'challenge': {
      const prompts = challengePrompts(runDir)
      writePrompts(runDir, prompts)
      return { voters: prompts.map(({ stem, voter, reviewer }) => ({ stem: voter, reviewer, promptPath: promptPath(runDir, stem) })) }
    }
    case 'skeptic': {
      const prompt = skepticPrompt(runDir)
      writePrompts(runDir, [prompt])
      return { model: SKEPTIC_MODEL, promptPath: promptPath(runDir, prompt.stem) }
    }
    default:
      return fail(`unknown phase "${phase}" (review, challenge or skeptic)`)
  }
}

if (isRunDirectly(import.meta.url)) {
  const [runDir, teamDir, ...flags] = process.argv.slice(2)
  if (!runDir || !teamDir) fail('usage: render-prompts.mjs <run-dir> <team-dir> [--phase review|challenge|skeptic]')
  const phaseIndex = flags.indexOf('--phase')
  const phase = phaseIndex === -1 ? 'review' : flags[phaseIndex + 1]
  try {
    console.log(JSON.stringify(render(phase, runDir, teamDir)))
  } catch (error) {
    fail(error.message)
  }
}
