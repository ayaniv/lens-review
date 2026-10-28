// undeclared-dependency: a test that uses a pytest plugin, or a JS/TS file that imports a
// package, which no dependency manifest at the head declares. The code passes on the author's
// machine, where the package happens to be installed, and fails on a clean install.
import { builtinModules } from 'node:module'
import path from 'node:path'
import { PartialPrecheckError, isFixture, isScriptFile, isTestFile, precheckFinding } from './finding.mjs'

const CHECK = 'undeclared-dependency'

// A plugin's fixture or marker → the distribution that provides it. General Python imports are
// out of scope: a module's name often isn't its distribution's (`yaml` is PyYAML), and telling
// the stdlib apart would need a list of its own.
const PYTEST_PLUGINS = [
  { name: 'pytest-mock', usage: /\b(mocker|pytest_mock)\b/ },
  { name: 'pytest-asyncio', usage: /\b(pytest\.mark\.asyncio|pytest_asyncio)\b/ },
  { name: 'pytest-httpx', usage: /\bhttpx_mock\b/ },
]
const PYTHON_MANIFEST_RE = /^(pyproject\.toml|requirements[^/]*\.txt|setup\.cfg|setup\.py|Pipfile)$/
const PACKAGE_JSON = 'package.json'
const TSCONFIG_RE = /^tsconfig[^/]*\.json$/
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

// Matched on a line whose strings are masked (see maskStrings), so a package named in a comment,
// a log message or a template string never counts: `import … from 'x'`, `export … from 'x'`,
// `} from 'x'` (closing a multi-line import), `import 'x'`, and `require('x')` or `import('x')`.
const STRING_MARK = '\u0001'
const JS_SPECIFIER_RES = [
  new RegExp(`^\\s*(?:import|export|\\})[^${STRING_MARK}]*?\\bfrom\\s*${STRING_MARK}(\\d+)${STRING_MARK}`, 'g'),
  new RegExp(`^\\s*import\\s*${STRING_MARK}(\\d+)${STRING_MARK}`, 'g'),
  new RegExp(`\\b(?:require|import)\\s*\\(\\s*${STRING_MARK}(\\d+)${STRING_MARK}\\s*\\)`, 'g'),
]
// A block comment's continuation line, which a line-at-a-time scan can't tell from code.
const BLOCK_COMMENT_LINE_RE = /^\s*\*/
// Paths, the usual path aliases (`@/x`, `~/x`, `#x` subpath imports, SvelteKit's `$lib/x`) and
// scheme specifiers (`node:fs`, `bun:test`, Vite's `virtual:x`, `astro:content`), never packages.
const NON_PACKAGE_SPECIFIER_RE = /^(\.|\/|@\/|~|#|\$)|^[\w-]+:/
const BUILTINS = new Set(builtinModules)

// pytest-mock, Pytest_Mock and pytest_mock all name the same distribution.
function normalizePythonName(text) {
  return text.toLowerCase().replace(/_/g, '-')
}

function manifestsNamed(repo, isManifest) {
  return repo.files().filter(file => isManifest(path.posix.basename(file)) && !isFixture(file))
}

// One finding per file, at its first added line that uses an undeclared package, naming every
// undeclared package the file uses. `packagesUsedBy` names the packages one line uses.
function firstUseFindings(diffFiles, packagesUsedBy, isDeclared, describe) {
  return diffFiles.flatMap(file => {
    const uses = file.added.map(({ line, text }) => ({ line, packages: packagesUsedBy(text).filter(name => !isDeclared(name)) })).filter(use => use.packages.length > 0)
    if (uses.length === 0) return []
    const packages = [...new Set(uses.flatMap(use => use.packages))]
    return [
      precheckFinding({
        check: CHECK,
        file: file.path,
        line: uses[0].line,
        severity: 'must',
        category: 'reliability',
        packages,
        description: describe(packages),
        rule: 'Every package the code or its tests use is declared in the dependency manifest.',
      }),
    ]
  })
}

function undeclaredPytestPlugins(diffFiles, repo) {
  const testFiles = diffFiles.filter(file => file.path.endsWith('.py') && isTestFile(file.path) && !isFixture(file.path))
  const pluginsUsedBy = text => PYTEST_PLUGINS.filter(plugin => plugin.usage.test(text)).map(plugin => plugin.name)
  if (!testFiles.some(file => file.added.some(({ text }) => pluginsUsedBy(text).length > 0))) return []
  const manifests = manifestsNamed(repo, name => PYTHON_MANIFEST_RE.test(name))
  if (manifests.length === 0) return []
  const declarations = manifests.map(file => normalizePythonName(repo.read(file) ?? '')).join('\n')
  const isDeclared = name => new RegExp(`(^|[^a-z0-9-])${name}([^a-z0-9-]|$)`, 'm').test(declarations)
  return firstUseFindings(
    testFiles,
    pluginsUsedBy,
    isDeclared,
    packages => `This test uses ${packages.join(', ')}, which no dependency manifest declares, so it fails on a clean install.`,
  )
}

// Removes `//` and `/* */` comments outside string literals, and passes each literal ('…', "…"
// or `…`, without its quotes) through `replaceString`, whose result stands in for it.
function scanCode(text, replaceString) {
  let code = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (text.startsWith('//', index)) {
      const lineEnd = text.indexOf('\n', index)
      index = lineEnd === -1 ? text.length : lineEnd
    } else if (text.startsWith('/*', index)) {
      const commentEnd = text.indexOf('*/', index + 2)
      index = commentEnd === -1 ? text.length : commentEnd + 2
    } else if (char === "'" || char === '"' || char === '`') {
      let end = index + 1
      while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1
      code += replaceString(text.slice(index + 1, end), char)
      index = end + 1
    } else {
      code += char
      index++
    }
  }
  return code
}

// The line with comments removed and each string literal replaced by a numbered mark.
function maskStrings(text) {
  const strings = []
  const code = scanCode(text, literal => `${STRING_MARK}${strings.push(literal) - 1}${STRING_MARK}`)
  return { code, strings }
}

// tsconfig files are JSONC: comments and trailing commas are allowed.
function parseJsonc(text) {
  const json = scanCode(text, (literal, quote) => `${quote}${literal}${quote}`)
  return JSON.parse(json.replace(/,(\s*[}\]])/g, '$1'))
}

// `@scope/name/sub` → `@scope/name`, `name/sub` → `name`.
function packageOf(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

// A top-level directory, or one under src/, can be imported bare through a baseUrl alias.
function aliasRoots(repo) {
  const roots = new Set()
  for (const file of repo.files()) {
    const segments = file.split('/')
    if (segments.length > 1) roots.add(segments[0])
    if (segments[0] === 'src' && segments.length > 2) roots.add(segments[1])
  }
  return roots
}

// Every tsconfig's compilerOptions.paths key: `@app/*` matches `@app/x`, `config` only itself.
function tsconfigPathAliases(repo) {
  return manifestsNamed(repo, name => TSCONFIG_RE.test(name)).flatMap(file => {
    let tsconfig
    try {
      tsconfig = parseJsonc(repo.read(file) ?? '')
    } catch (error) {
      throw new Error(`${file} is not valid JSONC: ${error.message}`)
    }
    return Object.keys(tsconfig?.compilerOptions?.paths ?? {})
  })
}

function isLocalImport(specifier, roots, pathAliases) {
  if (roots.has(specifier.split('/')[0])) return true
  return pathAliases.some(alias => (alias.endsWith('*') ? specifier.startsWith(alias.slice(0, -1)) : specifier === alias))
}

function importedPackages(text, isLocal) {
  if (BLOCK_COMMENT_LINE_RE.test(text)) return []
  const { code, strings } = maskStrings(text)
  const specifiers = JS_SPECIFIER_RES.flatMap(pattern => [...code.matchAll(pattern)].map(match => strings[Number(match[1])]))
  return [
    ...new Set(
      specifiers
        .filter(specifier => !NON_PACKAGE_SPECIFIER_RE.test(specifier) && !BUILTINS.has(specifier) && !BUILTINS.has(packageOf(specifier)))
        .filter(specifier => !isLocal(specifier))
        .map(packageOf),
    ),
  ]
}

// A package typed only through DefinitelyTyped: `estree` → `@types/estree`, `@scope/name` → `@types/scope__name`.
function typesPackageOf(name) {
  return `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`
}

function declaredJsPackages(repo, manifests) {
  const declared = new Set()
  for (const file of manifests) {
    let manifest
    try {
      manifest = JSON.parse(repo.read(file) ?? '')
    } catch (error) {
      throw new Error(`${file} is not valid JSON: ${error.message}`)
    }
    if (typeof manifest?.name === 'string') declared.add(manifest.name)
    for (const field of DEPENDENCY_FIELDS) for (const name of Object.keys(manifest?.[field] ?? {})) declared.add(name)
  }
  return declared
}

function undeclaredJsImports(diffFiles, repo) {
  const scriptFiles = diffFiles.filter(file => isScriptFile(file.path) && !isFixture(file.path))
  const roots = aliasRoots(repo)
  let pathAliases = null
  const packagesUsedBy = text =>
    importedPackages(text, specifier => {
      pathAliases ??= tsconfigPathAliases(repo)
      return isLocalImport(specifier, roots, pathAliases)
    })
  if (!scriptFiles.some(file => file.added.some(({ text }) => packagesUsedBy(text).length > 0))) return []
  const manifests = manifestsNamed(repo, name => name === PACKAGE_JSON)
  if (manifests.length === 0) return []
  const declared = declaredJsPackages(repo, manifests)
  return firstUseFindings(
    scriptFiles,
    packagesUsedBy,
    name => declared.has(name) || declared.has(typesPackageOf(name)),
    packages => `This file imports ${packages.join(', ')}, which no package.json declares, so it fails on a clean install.`,
  )
}

export function undeclaredDependency({ diffFiles, repo }) {
  const pytestFindings = undeclaredPytestPlugins(diffFiles, repo)
  // A broken package.json or tsconfig fails the JS half, which never costs the pytest findings.
  try {
    return [...pytestFindings, ...undeclaredJsImports(diffFiles, repo)]
  } catch (error) {
    throw new PartialPrecheckError(error.message, pytestFindings)
  }
}
