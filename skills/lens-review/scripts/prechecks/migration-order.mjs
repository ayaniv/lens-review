// migration-order: a new migration whose timestamp sorts wrong. Migration tools apply files
// in name order and refuse (or skip) one that sorts before what a database already has, so
// a new file must sort after every merged migration, and after every migration the plan
// names that hasn't merged yet: whichever of the two ships second would be refused.
import path from 'node:path'
import { precheckFinding } from './finding.mjs'

const MIGRATION_DIR_RE = /(^|\/)migrations?$/
// The version prefix migration tools sort by: a timestamp or sequence number.
const VERSION_RE = /^(\d{4,})[_-]/
const PLANNED_NAME_RE = /\b(\d{8,}[_-][\w.-]*\w)/g

function versionOf(fileName) {
  return fileName.match(VERSION_RE)?.[1] ?? null
}

function stem(fileName) {
  return fileName.replace(/\.[^.]+$/, '')
}

// Versions compare as numbers padded to one length, so 9 sorts before 10.
function sortsBefore(first, second) {
  const width = Math.max(first.length, second.length)
  return first.padStart(width, '0') < second.padStart(width, '0')
}

// `planDocs` is [{path, text}]: the plan docs the PR changes plus the ones the caller passed.
function plannedMigrations(planDocs, knownStems) {
  const planned = new Map()
  for (const { path: planDoc, text } of planDocs) {
    for (const [, name] of text.matchAll(PLANNED_NAME_RE)) {
      if (!knownStems.has(stem(name))) planned.set(stem(name), { name: stem(name), planDoc })
    }
  }
  return [...planned.values()]
}

export function migrationOrder({ diffFiles, repo, planDocs = [] }) {
  const newMigrations = diffFiles.filter(
    file => file.isNew && MIGRATION_DIR_RE.test(path.posix.dirname(file.path)) && versionOf(path.posix.basename(file.path)),
  )
  if (newMigrations.length === 0) return []
  const newPaths = new Set(newMigrations.map(file => file.path))
  const repoFiles = repo.files()
  const knownStems = new Set(repoFiles.map(file => stem(path.posix.basename(file))))
  const planned = plannedMigrations(planDocs, knownStems)
  const findings = []
  for (const migration of newMigrations) {
    const directory = path.posix.dirname(migration.path)
    const version = versionOf(path.posix.basename(migration.path))
    const mergedAfter = repoFiles
      .filter(file => path.posix.dirname(file) === directory && !newPaths.has(file))
      .map(file => path.posix.basename(file))
      .filter(name => versionOf(name) && sortsBefore(version, versionOf(name)))
    const plannedBefore = planned.filter(({ name }) => sortsBefore(versionOf(name), version))
    const reasons = [
      ...mergedAfter.map(name => `sorts before ${stem(name)}, which is already merged, so a database that has that one will refuse or skip this one`),
      ...plannedBefore.map(
        ({ name, planDoc }) => `sorts after ${name}, which ${planDoc} plans but which isn't merged, so whichever of the two ships second will be refused`,
      ),
    ]
    if (reasons.length === 0) continue
    findings.push(
      precheckFinding({
        check: 'migration-order',
        file: migration.path,
        line: 1,
        category: 'data',
        description: `${path.posix.basename(migration.path)} ${reasons.join('; and it ')}. Renumber so every migration sorts after the ones that ship before it.`,
        rule: 'A new migration sorts after every migration that ships before it, merged or planned.',
      }),
    )
  }
  return findings
}
