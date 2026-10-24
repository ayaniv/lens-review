import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SCRIPTS_DIR, makeTempDir, readText, runScript } from './helpers.mjs'

const PHASE_CLOCK = path.join(SCRIPTS_DIR, 'phase-clock.mjs')

describe('phase-clock.mjs', () => {
  let runDir
  let timingLine

  beforeEach(async () => {
    runDir = makeTempDir('phase-clock')
    ;({ timingLine } = await import(PHASE_CLOCK))
  })

  const clock = (...args) => runScript('node', [PHASE_CLOCK, runDir, ...args])

  test('appends each phase start and end to timings.json', () => {
    assert.equal(clock('review', 'start').status, 0)
    assert.equal(clock('review', 'end').status, 0)
    const timings = JSON.parse(readText(path.join(runDir, 'timings.json')))
    assert.deepEqual(timings.map(({ phase, event }) => [phase, event]), [['review', 'start'], ['review', 'end']])
    assert.ok(timings.every(({ at }) => Number.isFinite(Date.parse(at))))
  })

  test('the Timing line gives each phase its duration and the whole run, casting left out of the total', () => {
    const at = seconds => new Date(Date.UTC(2026, 9, 24, 12, 0, seconds)).toISOString()
    const timings = [
      { phase: 'gather', event: 'start', at: at(0) },
      { phase: 'gather', event: 'end', at: at(20) },
      { phase: 'casting', event: 'start', at: at(20) },
      { phase: 'casting', event: 'end', at: at(140) },
      { phase: 'review', event: 'start', at: at(140) },
      { phase: 'review', event: 'end', at: at(230) },
    ]
    assert.equal(timingLine(timings), 'Timing: gather 0:20, casting 2:00, review 1:30; total without casting 1:50')
  })

  test('a phase that started but never ended is shown as unfinished, not dropped', () => {
    const timings = [{ phase: 'skeptic', event: 'start', at: new Date().toISOString() }]
    assert.match(timingLine(timings), /skeptic unfinished/)
  })

  test('--summary prints the Timing line', () => {
    clock('gather', 'start')
    clock('gather', 'end')
    const result = clock('--summary')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^Timing: gather 0:0\d; total without casting 0:0\d$/m)
  })

  test('fails on an event that is not start or end, writing nothing', () => {
    const result = clock('review', 'halfway')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /lens-review: .*start or end/)
    assert.ok(!fs.existsSync(path.join(runDir, 'timings.json')))
  })

  test('fails naming timings.json when it is not a JSON array', () => {
    fs.writeFileSync(path.join(runDir, 'timings.json'), '{}')
    const result = clock('review', 'start')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /timings\.json/)
  })
})
