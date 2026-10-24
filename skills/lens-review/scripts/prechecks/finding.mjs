// What every precheck shares: the finding shape the merge expects (credited to "Precheck",
// with the check that produced it), and which files count as tests, fixtures or code.

export const PRECHECK_REVIEWER = 'Precheck'

export function precheckFinding({ check, file, line, severity = 'should', category, description, rule, ...extra }) {
  return { file, line, severity, category, description, rule, reviewer: PRECHECK_REVIEWER, check, ...extra }
}

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|e2e|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(go|py)$/
const FIXTURE_PATH_RE = /(^|\/)(fixtures?|__fixtures__|testdata|snapshots?|__snapshots__)\//
const CODE_EXTENSION_RE = /\.(c|m)?[jt]sx?$|\.(py|rb|go|rs|java|kt|swift|php|cs|sql|sh|bash)$/

export function isTestFile(filePath) {
  return TEST_PATH_RE.test(filePath)
}

export function isFixture(filePath) {
  return FIXTURE_PATH_RE.test(filePath)
}

export function isCodeFile(filePath) {
  return CODE_EXTENSION_RE.test(filePath)
}

export function isScriptFile(filePath) {
  return /\.(c|m)?[jt]sx?$/.test(filePath)
}
