import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// The one place the skill's name lives in the tests.
export const SKILL_NAME = 'lens-review'
export const SKILL_DIR = path.join(REPO_ROOT, 'skills', SKILL_NAME)
export const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts')

export function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

// Minimal YAML-frontmatter reader: `key: value`, folded/literal blocks (`key: >` / `key: |`),
// and inline lists (`key: ["a", "b"]`). Enough for SKILL.md and persona files; not general YAML.
export function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) return null
  const fields = {}
  let blockKey = null
  for (const line of match[1].split('\n')) {
    const keyMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (keyMatch) {
      const [, key, rawValue] = keyMatch
      blockKey = null
      if (rawValue === '>' || rawValue === '|') {
        blockKey = key
        fields[key] = ''
      } else if (rawValue.startsWith('[')) {
        fields[key] = JSON.parse(rawValue)
      } else {
        fields[key] = rawValue.replace(/^["']|["']$/g, '')
      }
    } else if (blockKey && line.trim()) {
      fields[blockKey] = `${fields[blockKey]} ${line.trim()}`.trim()
    }
  }
  return fields
}

export function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

export function runScript(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  return result
}

export function git(cwd, ...args) {
  const result = runScript('git', args, { cwd })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

// A throwaway repo with `main` + a `feature` branch, so diff-gathering runs against a real
// git history instead of the repo the tests live in.
export function makeGitRepo(filesOnMain, filesOnFeature) {
  const repoDir = makeTempDir('review-fixture-repo')
  git(repoDir, 'init', '-q', '-b', 'main')
  git(repoDir, 'config', 'user.email', 'fixture@example.com')
  git(repoDir, 'config', 'user.name', 'Fixture')
  writeFiles(repoDir, filesOnMain)
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-q', '-m', 'base')
  git(repoDir, 'checkout', '-q', '-b', 'feature')
  writeFiles(repoDir, filesOnFeature)
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-q', '-m', 'feature', '--allow-empty')
  return repoDir
}

export function writeFiles(rootDir, filesByRelativePath) {
  for (const [relativePath, contents] of Object.entries(filesByRelativePath)) {
    const absolutePath = path.join(rootDir, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, contents)
  }
}
