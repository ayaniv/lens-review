// unchecked-field: an optional-chained string or array method on a field nothing in the file
// type-checks, e.g. `finding.duplicates?.split(':')`. The `?.` guards against a missing field,
// not a wrong-typed one, so a field from parsed JSON or an agent reply that holds a number or
// an object throws there. Deliberately narrow: only the `?.method(` shape, only in script files.
import { isScriptFile, isTestFile, precheckFinding } from './finding.mjs'

const METHODS = 'split|trim|trimStart|trimEnd|toLowerCase|toUpperCase|startsWith|endsWith|includes|match|matchAll|replace|replaceAll|slice|padStart|map|filter|forEach|join|some|every|find|reduce|flatMap'
const OPTIONAL_METHOD_RE = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)\\?\\.(${METHODS})\\(`, 'g')

function isTypeChecked(fileText, object, field) {
  const access = `(?:${object}\\.)?${field}`
  return new RegExp(`typeof\\s+\\(?\\s*${access}\\b|Array\\.isArray\\(\\s*${access}\\s*\\)|\\b${access}\\s+instanceof\\b`).test(fileText)
}

export function uncheckedField({ diffFiles, repo }) {
  const findings = []
  for (const file of diffFiles.filter(diffFile => isScriptFile(diffFile.path) && !isTestFile(diffFile.path))) {
    const fileText = repo.read(file.path) ?? file.added.map(({ text }) => text).join('\n')
    for (const { line, text } of file.added) {
      for (const [, object, field, method] of text.matchAll(OPTIONAL_METHOD_RE)) {
        if (isTypeChecked(fileText, object.replace(/\$/g, '\\$'), field.replace(/\$/g, '\\$'))) continue
        findings.push(
          precheckFinding({
            check: 'unchecked-field',
            file: file.path,
            line,
            category: 'reliability',
            description: `${object}.${field}?.${method}() assumes ${field} is a string or array whenever it is present, and nothing in this file checks its type. A ${field} that is a number or an object throws here.`,
            rule: 'Agent output and parsed JSON are untrusted: check a field\'s type before calling its methods.',
          }),
        )
      }
    }
  }
  return findings
}
