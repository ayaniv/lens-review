// Records when each phase of a run starts and ends, so wall time can be split by phase
// instead of guessed from a transcript afterwards.
//
//   node phase-clock.mjs <run-dir> <phase> start|end   → appends to <run-dir>/timings.json
//   node phase-clock.mjs <run-dir> --summary           → prints the `Timing:` telemetry line
import fs from 'node:fs'
import path from 'node:path'
import { fail, isRunDirectly, readJsonArrayFile } from './lib/cli.mjs'
import { writeJson } from './parse-reply.mjs'

const EVENTS = ['start', 'end']
// Casting runs once per repo, so a run's comparable wall time leaves it out.
const ONCE_PER_REPO_PHASE = 'casting'

function minutesAndSeconds(milliseconds) {
  const totalSeconds = Math.round(milliseconds / 1000)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}

export function timingLine(timings) {
  const phases = []
  for (const { phase, event, at } of timings) {
    let entry = phases.findLast(candidate => candidate.phase === phase && candidate.end === undefined)
    if (event === 'start' || !entry) {
      entry = { phase, start: Date.parse(at) }
      phases.push(entry)
    }
    if (event === 'end') entry.end = Date.parse(at)
  }
  const finished = phases.filter(({ end }) => end !== undefined)
  const parts = phases.map(({ phase, start, end }) => (end === undefined ? `${phase} unfinished` : `${phase} ${minutesAndSeconds(end - start)}`))
  const total = finished.filter(({ phase }) => phase !== ONCE_PER_REPO_PHASE).reduce((sum, { start, end }) => sum + (end - start), 0)
  return `Timing: ${parts.join(', ')}; total without casting ${minutesAndSeconds(total)}`
}

function readTimings(timingsPath) {
  return fs.existsSync(timingsPath) ? readJsonArrayFile(timingsPath) : []
}

if (isRunDirectly(import.meta.url)) {
  const [runDir, phase, event] = process.argv.slice(2)
  if (!runDir || !phase) fail('usage: phase-clock.mjs <run-dir> <phase> start|end  |  phase-clock.mjs <run-dir> --summary')
  const timingsPath = path.join(runDir, 'timings.json')
  if (phase === '--summary') {
    console.log(timingLine(readTimings(timingsPath)))
  } else {
    if (!EVENTS.includes(event)) fail(`event must be start or end, not "${event}"`)
    writeJson(timingsPath, [...readTimings(timingsPath), { phase, event, at: new Date().toISOString() }])
  }
}
