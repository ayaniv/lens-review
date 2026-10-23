// Prints (and creates) the dir where a repo's cast team lives:
// ${LENS_REVIEW_HOME:-~/.claude/lens-review}/teams/<repo-slug>/. It sits outside the reviewed
// repo so a review never dirties its working tree, and outside the skill so one install
// serves every repo.
//
//   node team-dir.mjs --repo <dir>
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fail, isRunDirectly } from './lib/cli.mjs'

// Long enough to tell apart two same-named checkouts without a remote.
const PATH_HASH_LENGTH = 8

function gitOutput(repoDir, ...args) {
  const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

// git@github.com:acme/web.git and https://github.com/acme/web both become "acme-web".
export function slugFromRemote(remoteUrl) {
  const repoPath = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^[a-z+]+:\/\/[^/]+\//i, '')
    .replace(/^[^@/]+@[^:]+:/, '')
  return repoPath.split('/').filter(Boolean).join('-').replace(/[^\w.-]/g, '_')
}

function slugFromPath(topLevel) {
  const pathHash = crypto.createHash('sha1').update(topLevel).digest('hex').slice(0, PATH_HASH_LENGTH)
  return `${path.basename(topLevel)}-${pathHash}`
}

export function teamDirFor(repoDir, lensReviewHome) {
  const topLevel = gitOutput(repoDir, 'rev-parse', '--show-toplevel')
  if (!topLevel) throw new Error(`not a git repository: ${repoDir}`)
  const remoteUrl = gitOutput(repoDir, 'remote', 'get-url', 'origin')
  const slug = remoteUrl ? slugFromRemote(remoteUrl) : slugFromPath(topLevel)
  return path.join(lensReviewHome, 'teams', slug)
}

if (isRunDirectly(import.meta.url)) {
  const repoFlagIndex = process.argv.indexOf('--repo')
  const repoDir = repoFlagIndex === -1 ? null : process.argv[repoFlagIndex + 1]
  if (!repoDir) fail('usage: team-dir.mjs --repo <dir>')
  const lensReviewHome = process.env.LENS_REVIEW_HOME || path.join(os.homedir(), '.claude', 'lens-review')
  try {
    const teamDir = teamDirFor(repoDir, lensReviewHome)
    fs.mkdirSync(teamDir, { recursive: true })
    console.log(teamDir)
  } catch (error) {
    fail(error.message)
  }
}
