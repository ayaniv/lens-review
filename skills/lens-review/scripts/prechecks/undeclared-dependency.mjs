// undeclared-dependency: a test that uses a pytest plugin, or a JS/TS file that imports a
// package, which no dependency manifest at the head declares. The code passes on the author's
// machine, where the package happens to be installed, and fails on a clean install.
import { builtinModules } from 'node:module'
import path from 'node:path'
import { isFixture, isScriptFile, isTestFile, precheckFinding } from './finding.mjs'

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
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

// import … from 'x', export … from 'x', import 'x', require('x'), import('x').
const JS_SPECIFIER_RES = [/\bfrom\s+(['"])([^'"]+)\1/g, /\bimport\s+(['"])([^'"]+)\1/g, /\b(?:require|import)\s*\(\s*(['"])([^'"]+)\1\s*\)/g]
// Paths and the usual path aliases (`@/x`, `~/x`, `#x` subpath imports), never packages.
const NON_PACKAGE_SPECIFIER_RE = /^(\.|\/|node:|@\/|~|#)/
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

function importedPackages(text, isLocal) {
  const specifiers = JS_SPECIFIER_RES.flatMap(pattern => [...text.matchAll(pattern)].map(match => match[2]))
  return [
    ...new Set(
      specifiers
        .filter(specifier => !NON_PACKAGE_SPECIFIER_RE.test(specifier) && !BUILTINS.has(specifier) && !BUILTINS.has(packageOf(specifier)))
        .filter(specifier => !isLocal(specifier.split('/')[0]))
        .map(packageOf),
    ),
  ]
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
  const packagesUsedBy = text => importedPackages(text, root => roots.has(root))
  if (!scriptFiles.some(file => file.added.some(({ text }) => packagesUsedBy(text).length > 0))) return []
  const manifests = manifestsNamed(repo, name => name === PACKAGE_JSON)
  if (manifests.length === 0) return []
  const declared = declaredJsPackages(repo, manifests)
  return firstUseFindings(
    scriptFiles,
    packagesUsedBy,
    name => declared.has(name),
    packages => `This file imports ${packages.join(', ')}, which no package.json declares, so it fails on a clean install.`,
  )
}

export function undeclaredDependency({ diffFiles, repo }) {
  return [...undeclaredPytestPlugins(diffFiles, repo), ...undeclaredJsImports(diffFiles, repo)]
}
