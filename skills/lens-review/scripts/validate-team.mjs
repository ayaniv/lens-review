// Parses and validates persona files:
//
//   # <Name>
//
//   Scope:
//   - <glob>
//
//   Rules:
//   - [must|should|suggestion] <rule, may wrap onto indented lines>
//
//   node validate-team.mjs <team-dir>   → JSON summary of the team on stdout, or every
//                                         malformed file named on stderr and a non-zero exit
import fs from 'node:fs'
import path from 'node:path'
import { fail, isRunDirectly } from './lib/cli.mjs'

const DEFAULT_RULE_SEVERITY = 'should'
const SEVERITY_TAG_RE = /^\[(must|should|suggestion)\]\s*/
const SECTION_RE = /^(Scope|Rules):\s*$/

function parseSections(markdown) {
  const sections = { Scope: [], Rules: [] }
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

export function parsePersona(markdown) {
  const name = markdown.match(/^# (.+)$/m)?.[1].trim()
  if (!name) throw new Error('no "# <Name>" heading')
  const { Scope: scope, Rules: ruleTexts } = parseSections(markdown)
  if (scope.length === 0) throw new Error(`${name}: no Scope globs`)
  if (ruleTexts.length === 0) throw new Error(`${name}: no Rules`)
  return { name, scope, rules: ruleTexts.map(parseRule) }
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
    console.log(JSON.stringify(team.map(({ file, name, scope }) => ({ file, name, scope })), null, 2))
  } catch (error) {
    fail(error.message)
  }
}
