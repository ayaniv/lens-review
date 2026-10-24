// newly-unused: code the diff leaves with no caller. Two shapes:
// - a function whose last caller the diff removes, while its definition stays;
// - a CLI flag the diff adds that nothing passes: only its own script and tests mention it.
// Callers are counted with git grep at the head; tests don't count, since a test of dead
// code is part of the dead surface.
import { isCodeFile, isScriptFile, isTestFile, precheckFinding } from './finding.mjs'

const CALL_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g
const DEFINITION_KEYWORD_RE = /\b(?:function|def|class)\s*$/
// A quoted flag that code compares argv against: the flag's definition, not a mention of it.
const FLAG_DEFINITION_RE = /(?:indexOf\(|includes\(|===?\s*|case\s+|add_argument\()\s*(['"`])(--[a-z][\w-]*)\1/g
// Names no repo defines: a removed call to one is never the last caller of anything.
const IGNORED_CALLS = new Set(
  'if for while switch catch return typeof function require import super constructor describe test it expect assert'.split(' '),
)

// `$` is legal in a JS name and special in a regex.
function escapeName(name) {
  return name.replace(/\$/g, '\\$')
}

function definitionRe(rawName) {
  const name = escapeName(rawName)
  return new RegExp(`\\b(?:function\\*?|def|class)\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\s*=|^\\s*${name}\\s*[:=]\\s*(?:async\\s*)?(?:\\(|function)`)
}

function isImportOrExportList(text, rawName) {
  const name = escapeName(rawName)
  return new RegExp(`^\\s*(?:import|export)\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b`).test(text) || /^\s*import\b.*\bfrom\b/.test(text)
}

function isCommentLine(text) {
  return /^\s*(\/\/|\/\*|\*|#)/.test(text)
}

// The new-side line a removal sits at, moved into a hunk the merge accepts.
function anchorLine(file, line) {
  const hunk = file.hunks.find(([first, last]) => first <= last && line >= first - 1 && line <= last + 1) ?? file.hunks.find(([first, last]) => first <= last)
  return hunk ? Math.min(Math.max(line, hunk[0]), hunk[1]) : null
}

function removedCalls(diffFiles) {
  const calls = new Map()
  // Calls in prose (a skill or a README) name no definition a grep could find.
  for (const file of diffFiles.filter(diffFile => isCodeFile(diffFile.path))) {
    for (const { line, text } of file.removed) {
      for (const match of text.matchAll(CALL_RE)) {
        const name = match[1]
        if (IGNORED_CALLS.has(name) || DEFINITION_KEYWORD_RE.test(text.slice(0, match.index))) continue
        if (!calls.has(name)) calls.set(name, { file, line })
      }
    }
  }
  return calls
}

function unusedFunctions({ diffFiles, repo }) {
  const addedText = diffFiles.flatMap(file => file.added.map(({ text }) => text)).join('\n')
  const findings = []
  for (const [name, removal] of removedCalls(diffFiles)) {
    // A call the diff adds back elsewhere is a caller.
    if (new RegExp(`(?<![\\w$.])${escapeName(name)}\\s*\\(`).test(addedText)) continue
    const mentions = repo.grepWord(name)
    const definitions = mentions.filter(({ text }) => definitionRe(name).test(text))
    if (definitions.length === 0) continue
    const callers = mentions.filter(
      ({ file, text }) => !definitionRe(name).test(text) && !isTestFile(file) && !isImportOrExportList(text, name) && !isCommentLine(text),
    )
    if (callers.length > 0) continue
    const [definition] = definitions
    const line = anchorLine(removal.file, removal.line)
    if (line === null) continue
    findings.push(
      precheckFinding({
        check: 'newly-unused',
        file: removal.file.path,
        line,
        category: 'maintainability',
        description: `This diff removes the last call to ${name}, but its definition stays at ${definition.file}:${definition.line}. Delete it, or say what still needs it.`,
        rule: 'No dead code before it ships.',
      }),
    )
  }
  return findings
}

function unusedFlags({ diffFiles, repo }) {
  const findings = []
  for (const file of diffFiles.filter(diffFile => isScriptFile(diffFile.path) && !isTestFile(diffFile.path))) {
    for (const { line, text } of file.added) {
      for (const [, , flag] of text.matchAll(FLAG_DEFINITION_RE)) {
        const passedFrom = repo.grepWord(flag).filter(mention => mention.file !== file.path && !isTestFile(mention.file))
        if (passedFrom.length > 0) continue
        findings.push(
          precheckFinding({
            check: 'newly-unused',
            file: file.path,
            line,
            category: 'maintainability',
            description: `The ${flag} flag this diff adds is passed by nothing but tests: no script, skill or doc uses it. Drop the flag, or use it.`,
            rule: 'No dead code before it ships.',
          }),
        )
      }
    }
  }
  return findings
}

export function newlyUnused(change) {
  return [...unusedFunctions(change), ...unusedFlags(change)]
}
