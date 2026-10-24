// untested-failure-path: an error message the diff adds that no test file mentions. A test
// that covers a failure path almost always asserts on (part of) its message, so a message no
// test names is a failure path no test reaches.
import { isTestFile, precheckFinding } from './finding.mjs'

// throw new Error('…') / fail('…') in JS, raise exception '…' in SQL, raise ValueError('…') in Python.
const MESSAGE_PATTERNS = [
  /\b(?:throw\s+new\s+\w*Error|fail)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/,
  /\braise\s+exception\s+'((?:''|[^'])*)'/i,
  /\braise\s+\w*(?:Error|Exception)\(\s*(['"])((?:\\.|(?!\1).)*)\1/,
]
// Usage and argument-parsing errors are the CLI's own help text, not a failure path a test should pin.
const USAGE_RE = /^(usage\b|\$\{usage\}|unknown (argument|option|flag)\b)/i
const STOPWORDS = new Set('a an the is are was be not no of to in on for and or but it its this that with as at by from has have when'.split(' '))
// A quoted window has to carry this many content words: "is not a" is in every other message.
const MIN_CONTENT_WORDS = 2
// How much of a message a test has to repeat: three words in a row, or one placeholder-free
// run of at least this many characters when the message is shorter than that.
const WINDOW_WORDS = 3
const MIN_FRAGMENT_CHARS = 12

function addedMessage(text) {
  for (const pattern of MESSAGE_PATTERNS) {
    const match = text.match(pattern)
    if (match) return match.at(-1).replace(/''/g, "'").replace(/\\(.)/g, '$1')
  }
  return null
}

// The message's literal parts, split at every interpolation or format placeholder.
function literalFragments(message) {
  return message
    .split(/\$\{[^}]*\}|%[sdif]?|\{\w*\}/)
    .map(fragment => fragment.toLowerCase().replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function windowsOfWords(words) {
  if (words.length >= WINDOW_WORDS) return words.slice(0, words.length - WINDOW_WORDS + 1).map((_, index) => words.slice(index, index + WINDOW_WORDS).join(' '))
  const fragment = words.join(' ')
  return fragment.length >= MIN_FRAGMENT_CHARS ? [fragment] : []
}

// Each window as written, and with punctuation stripped from its words' edges ("group:",
// "(add"), since a test may quote either: /exactly one group/ or /is not <stem>=<reviewer>/.
function wordWindows(message) {
  return literalFragments(message).flatMap(fragment => {
    const words = fragment.split(' ')
    const raw = windowsOfWords(words)
    // Same word count as `raw`, so the two lists line up window for window.
    const stripped = windowsOfWords(words.map(word => word.replace(/^[^\w']+|[^\w']+$/g, ''))).map(window => window.replace(/\s+/g, ' ').trim())
    return raw.map((window, index) => [window, stripped[index]].filter(Boolean))
  })
}

function contentWordCount(piece) {
  return piece.split(' ').filter(word => !STOPWORDS.has(word.replace(/[^\w']/g, ''))).length
}

// The pieces of a message a test would quote, any one of which means its path is tested: a
// window with enough content words that no other message the diff adds shares it, so a test
// quoting a sibling error ("is not a JSON array of findings") doesn't cover this one.
// Each piece is its variants, any one of which a test may quote.
function distinctivePieces(message, otherMessages) {
  const shared = new Set(otherMessages.flatMap(wordWindows).flat())
  return wordWindows(message).filter(([window]) => contentWordCount(window) >= MIN_CONTENT_WORDS && !shared.has(window))
}

// A test usually quotes a message inside a regex literal, where `/`, `.` and `(` arrive escaped.
function asRegexSource(piece) {
  return piece.replace(/[/.*+?()[\]{}|^$]/g, '\\$&')
}

function isMentionedByATest(repo, pieces) {
  const quotes = pieces.flat().flatMap(piece => [...new Set([piece, asRegexSource(piece)])])
  return repo.filesContainingAny(quotes).some(isTestFile)
}

export function untestedFailurePath({ diffFiles, repo }) {
  const sourceFiles = diffFiles.filter(file => !isTestFile(file.path))
  // A message the diff only moves (removed in one place, added in another) is not a new path.
  const removedMessages = new Set(sourceFiles.flatMap(file => file.removed.map(({ text }) => addedMessage(text))).filter(Boolean))
  const added = sourceFiles
    .flatMap(file => file.added.map(({ line, text }) => ({ file: file.path, line, message: addedMessage(text) })))
    .filter(({ message }) => message && !USAGE_RE.test(message.trim()) && !removedMessages.has(message))
  return added
    .filter(({ message }, index) => {
      const pieces = distinctivePieces(message, added.filter((_, other) => other !== index).map(other => other.message))
      return pieces.length > 0 && !isMentionedByATest(repo, pieces)
    })
    .map(({ file, line, message }) =>
      precheckFinding({
        check: 'untested-failure-path',
        file,
        line,
        category: 'tests',
        message,
        description: `No test mentions the error "${message}" that this line adds, so its failure path is untested.`,
        rule: 'Every new error path gets a failure-path test.',
      }),
    )
}
