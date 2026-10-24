// Parses and validates persona files:
//
//   # <Name>
//
//   Scope:
//   - <glob>
//
//   Signals:
//   - <regex, matched against every line the PR adds or removes, in any file>
//
//   Rules:
//   - [must|should|suggestion] <rule, may wrap onto indented lines>
//
// Scope says where the persona's code lives; Signals say what its concern looks like, so it
// joins a PR that touches that concern from anywhere. Either may be left out, not both.
//
//   node validate-team.mjs <team-dir>   → JSON summary of the team on stdout, or every
//                                         malformed file named on stderr and a non-zero exit
import fs from 'node:fs'
import path from 'node:path'
import { fail, isRunDirectly } from './lib/cli.mjs'

const DEFAULT_RULE_SEVERITY = 'should'
const SEVERITY_TAG_RE = /^\[(must|should|suggestion)\]\s*/
const SECTION_RE = /^(Scope|Signals|Rules):\s*$/
// Casting output is untrusted, and every signal runs against every changed line, so a short
// cap keeps a crafted pattern from stalling selection on a big diff.
const MAX_SIGNAL_LENGTH = 200

function parseSections(markdown) {
  const sections = { Scope: [], Signals: [], Rules: [] }
  let currentItems = null
  for (const line of markdown.split('\n')) {
    const sectionMatch = line.match(SECTION_RE)
    if (sectionMatch) {
      currentItems = sections[sectionMatch[1]]
    } else if (/^#/.test(line)) {
      currentItems = null
    } else if (currentItems && line.startsWith('- ')) {
      currentItems.push(line.slice(2).trim())
    } else if (currentItems && currentItems.length > 0 && /^\s+\S/.test(line)) {
      currentItems[currentItems.length - 1] += ` ${line.trim()}`
    }
  }
  return sections
}

function parseRule(ruleText) {
  const tagMatch = ruleText.match(SEVERITY_TAG_RE)
  return tagMatch
    ? { severity: tagMatch[1], text: ruleText.slice(tagMatch[0].length) }
    : { severity: DEFAULT_RULE_SEVERITY, text: ruleText }
}

function parseSignal(name, source) {
  if (source.length > MAX_SIGNAL_LENGTH) {
    throw new Error(`${name}: signal "${source.slice(0, 40)}…" is longer than ${MAX_SIGNAL_LENGTH} characters`)
  }
  let signal
  try {
    signal = new RegExp(source)
  } catch (error) {
    throw new Error(`${name}: signal "${source}" is not a valid regex (${error.message})`)
  }
  if (signal.test('')) throw new Error(`${name}: signal "${source}" matches an empty line, so it would match every PR`)
  return signal
}

export function parsePersona(markdown) {
  const name = markdown.match(/^# (.+)$/m)?.[1].trim()
  if (!name) throw new Error('no "# <Name>" heading')
  const { Scope: scope, Signals: signalSources, Rules: ruleTexts } = parseSections(markdown)
  if (scope.length === 0 && signalSources.length === 0) throw new Error(`${name}: no Scope globs or Signals`)
  if (ruleTexts.length === 0) throw new Error(`${name}: no Rules`)
  return { name, scope, signals: signalSources.map(source => parseSignal(name, source)), rules: ruleTexts.map(parseRule) }
}

export function isCorePersona(persona) {
  return persona.scope.length === 1 && persona.scope[0] === '**'
}

// Core personas first, then the scoped ones, each group in file-name order, so the panel
// reads the same on every run.
function byCoreThenFile(first, second) {
  return Number(isCorePersona(second)) - Number(isCorePersona(first)) || first.file.localeCompare(second.file)
}

// Throws one error naming every malformed file: a team with a broken persona is never used
// partially, because a silently dropped persona would mean a silently skipped lens.
export function loadTeam(teamDir) {
  if (!fs.existsSync(teamDir)) throw new Error(`team dir not found: ${teamDir}`)
  const personaFiles = fs.readdirSync(teamDir).filter(fileName => fileName.endsWith('.md'))
  if (personaFiles.length === 0) throw new Error(`no persona files (*.md) in ${teamDir}`)
  const team = []
  const errors = []
  for (const file of personaFiles) {
    try {
      team.push({ file, ...parsePersona(fs.readFileSync(path.join(teamDir, file), 'utf8')) })
    } catch (error) {
      errors.push(`${file}: ${error.message}`)
    }
  }
  const namesSeen = new Set()
  for (const persona of team) {
    if (namesSeen.has(persona.name)) errors.push(`${persona.file}: another persona is already named "${persona.name}"`)
    namesSeen.add(persona.name)
  }
  if (errors.length > 0) throw new Error(`invalid team in ${teamDir}:\n  ${errors.join('\n  ')}`)
  return team.sort(byCoreThenFile)
}

if (isRunDirectly(import.meta.url)) {
  const teamDir = process.argv[2]
  if (!teamDir) fail('usage: validate-team.mjs <team-dir>')
  try {
    const team = loadTeam(teamDir)
    const summary = team.map(({ file, name, scope, signals }) => ({ file, name, scope, signals: signals.map(signal => signal.source) }))
    console.log(JSON.stringify(summary, null, 2))
  } catch (error) {
    fail(error.message)
  }
}
