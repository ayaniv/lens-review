// Picks this PR's panel: every core persona, plus each scoped persona a changed file matches.
//
//   node select-team.mjs <team-dir> <files.txt>
//     → {panel, selected: [{file, name, matchedBy}], uncoveredFiles} as JSON on stdout
import path from 'node:path'
import { fail, isRunDirectly, readTextFile } from './lib/cli.mjs'
import { isCorePersona, loadTeam } from './validate-team.mjs'

// path.matchesGlob never lets `*`/`**` match a dot-segment, so `**/*.yml` would miss
// `.github/workflows/ci.yml`. Matching the dot-stripped path too keeps CI and dotfiles in scope.
function withoutLeadingDots(file) {
  return file
    .split('/')
    .map(segment => segment.replace(/^\./, ''))
    .join('/')
}

function matchesScope(file, scope) {
  return scope.some(glob => path.posix.matchesGlob(file, glob) || path.posix.matchesGlob(withoutLeadingDots(file), glob))
}

export function selectTeam(team, changedFiles) {
  const selected = []
  const coveredFiles = new Set()
  for (const persona of team) {
    if (isCorePersona(persona)) {
      selected.push({ ...persona, matchedBy: [] })
      continue
    }
    const matchedBy = changedFiles.filter(file => matchesScope(file, persona.scope))
    if (matchedBy.length === 0) continue
    matchedBy.forEach(file => coveredFiles.add(file))
    selected.push({ ...persona, matchedBy })
  }
  return { selected, uncoveredFiles: changedFiles.filter(file => !coveredFiles.has(file)) }
}

// e.g. "Panel: core ×5 + The Backend Reviewer (api/orders.ts) + The Design System Guardian (web/A.tsx, +2 more)"
export function formatPanel(selected) {
  const coreCount = selected.filter(isCorePersona).length
  const scoped = selected
    .filter(persona => !isCorePersona(persona))
    .map(({ name, matchedBy: [firstFile, ...otherFiles] }) => {
      const more = otherFiles.length > 0 ? `, +${otherFiles.length} more` : ''
      return `${name} (${firstFile}${more})`
    })
  return `Panel: ${[`core ×${coreCount}`, ...scoped].join(' + ')}`
}

if (isRunDirectly(import.meta.url)) {
  const [teamDir, filesListPath] = process.argv.slice(2)
  if (!teamDir || !filesListPath) fail('usage: select-team.mjs <team-dir> <files.txt>')
  const changedFiles = readTextFile(filesListPath).split('\n').filter(Boolean)
  if (changedFiles.length === 0) fail(`no changed files listed in ${filesListPath}`)
  let team
  try {
    team = loadTeam(teamDir)
  } catch (error) {
    fail(error.message)
  }
  const { selected, uncoveredFiles } = selectTeam(team, changedFiles)
  const panel = formatPanel(selected)
  console.log(
    JSON.stringify(
      { panel, selected: selected.map(({ file, name, matchedBy }) => ({ file, name, matchedBy })), uncoveredFiles },
      null,
      2,
    ),
  )
}
