// Turns one agent's raw reply into the JSON file the next step reads. Agents are told to
// return bare JSON, but some still wrap it in a code fence; stripping that here, the same way
// every run, keeps "is this reviewer failed?" from depending on the orchestrator's judgement.
// Anything else that isn't JSON fails, and the caller counts that agent as failed.
//
//   node parse-reply.mjs <reply.txt> <out.json>   → writes out.json; non-zero exit when not JSON
import fs from 'node:fs'
import { fail, isRunDirectly, readTextFile } from './lib/cli.mjs'

const WHOLE_REPLY_FENCE = /^```[\w-]*\n([\s\S]*?)\n```$/

export function unfence(replyText) {
  const trimmed = replyText.trim()
  return trimmed.match(WHOLE_REPLY_FENCE)?.[1] ?? trimmed
}

if (isRunDirectly(import.meta.url)) {
  const [replyPath, outPath] = process.argv.slice(2)
  if (!replyPath || !outPath) fail('usage: parse-reply.mjs <reply.txt> <out.json>')
  let parsed
  try {
    parsed = JSON.parse(unfence(readTextFile(replyPath)))
  } catch (error) {
    fail(`${replyPath} is not a JSON reply (a single surrounding code fence is the only wrapper allowed): ${error.message}`)
  }
  fs.writeFileSync(outPath, `${JSON.stringify(parsed, null, 2)}\n`)
}
