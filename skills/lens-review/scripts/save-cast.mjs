// Writes the casting agent's personas into the team dir. Casting reads the reviewed repo's own
// rule files, so its output is untrusted: every file name must be a bare kebab-case .md name
// and every persona must parse before anything is written, so a bad cast leaves no partial team.
//
//   node save-cast.mjs <team-dir> <cast.json>   (cast.json: [{file, markdown}])
import fs from 'node:fs'
import path from 'node:path'
import { fail, isRunDirectly, readJsonArrayFile } from './lib/cli.mjs'
import { parsePersona } from './validate-team.mjs'

const PERSONA_FILE_NAME_RE = /^[a-z0-9][a-z0-9-]*\.md$/

function castErrors(cast) {
  const errors = []
  const fileNamesSeen = new Set()
  for (const entry of cast) {
    if (typeof entry?.file !== 'string' || !PERSONA_FILE_NAME_RE.test(entry.file)) {
      errors.push(`"${entry?.file}": not a bare kebab-case .md file name`)
      continue
    }
    if (fileNamesSeen.has(entry.file)) errors.push(`${entry.file}: cast more than once`)
    fileNamesSeen.add(entry.file)
    try {
      parsePersona(String(entry.markdown ?? ''))
    } catch (error) {
      errors.push(`${entry.file}: ${error.message}`)
    }
  }
  return errors
}

if (isRunDirectly(import.meta.url)) {
  const [teamDir, castPath] = process.argv.slice(2)
  if (!teamDir || !castPath) fail('usage: save-cast.mjs <team-dir> <cast.json>')
  const cast = readJsonArrayFile(castPath)
  const errors = castErrors(cast)
  if (errors.length > 0) fail(`invalid cast in ${castPath}, nothing written:\n  ${errors.join('\n  ')}`)
  for (const { file, markdown } of cast) fs.writeFileSync(path.join(teamDir, file), markdown)
  console.log(cast.map(({ file }) => file).join('\n'))
}
