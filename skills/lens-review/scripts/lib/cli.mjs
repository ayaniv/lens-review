// Shared CLI plumbing for the lens-review scripts: every failure goes to stderr, names the
// input that caused it, and exits non-zero, so the orchestrating session can see what broke.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export function fail(message) {
  console.error(`lens-review: ${message}`)
  process.exit(1)
}

// Malformed findings/votes are dropped rather than crashing a run, but never silently.
export function reportDropped(kind, dropped) {
  if (dropped.length === 0) return
  console.error(`lens-review: dropped ${dropped.length} malformed ${kind}`)
  for (const { item, reason } of dropped) console.error(`  - ${reason}: ${JSON.stringify(item)}`)
}

export function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    fail(`cannot read ${filePath}: ${error.message}`)
  }
}

export function readJsonFile(filePath) {
  const text = readTextFile(filePath)
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(`${filePath} is not valid JSON: ${error.message}`)
  }
}

export function readJsonArrayFile(filePath) {
  const parsed = readJsonFile(filePath)
  if (!Array.isArray(parsed)) fail(`${filePath} must hold a JSON array`)
  return parsed
}

export function isRunDirectly(moduleUrl) {
  return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(moduleUrl))
}
