# ReviewBench as the benchmark for lens-review

**QA Spec:** `tests/lens-review-reviewbench.test.mjs`

## Summary

This plan makes ReviewBench, an open benchmark of 219 real PRs with reference findings and an LLM judge, the yardstick for lens-review. A small harness under `tests/lens-review-eval/reviewbench/` downloads ReviewBench cases into PR #7's eval-case layout, runs lens-review on each one headless, converts the kept findings into ReviewBench's judging format, and reads the judge's scores. ReviewBench's own judge replaces our hand-built answer keys, so lens-review gets scored against reference findings someone else wrote. Every live review and judge run sits behind an approval file with a count and a budget, and the first step after merge is a 3-PR pilot, about $11. Each review runs isolated from the developer's own Claude Code setup and from any hooks the reviewed repo ships, so the score measures lens-review alone.

## Verified facts about ReviewBench

Checked against https://github.com/review-bench/ReviewBench at commit `36d10aea5cd9d40d1a564c0e6a0d84ca814a872c` (2026-10-23). Plan review re-checked every row against a fresh fetch of that commit on 2026-10-24, and everything below holds unless a row says otherwise.

| Claim | Verified |
|---|---|
| Maintainer | The `review-bench` GitHub organization (created 2026-09-04). The README says "developed by GitHub"; I found nothing beyond the README that confirms GitHub's involvement. |
| License | MIT, © 2026 review-bench ([LICENSE](https://github.com/review-bench/ReviewBench/blob/main/LICENSE)). |
| 219 PRs from 187 repos | Yes: `corpus/manifest.json` has 219 entries and 187 distinct repos. `golden/` has 219 files with 4,632 labeled findings (TP and FP). |
| 25-PR test set | `corpus/test/test.json` (25 manifest entries), with `picks.md` explaining each pick. 13 languages; 7 of the 25 PRs change more than 1,000 lines (the largest, simnaut/emdash#2, changes 14,642). |
| Metrics | Grounded and augmented precision and recall, macro and micro, broken down by severity (high/medium/low) and category (correctness, reliability, maintainability, testing, security, documentation, performance, api-architecture, accessibility). See [METHODOLOGY.md §7](https://github.com/review-bench/ReviewBench/blob/main/docs/METHODOLOGY.md). |
| Judging CLI | `npm run judge -- --candidate <file or dir> --provider <p> --model <id> --output <results.json> [--repo-dir] [--limit] [--concurrency]` ([JUDGING.md](https://github.com/review-bench/ReviewBench/blob/main/docs/JUDGING.md)). It uses an LLM to match our findings to the golden ones within each file, then has an agent (with read access to the repo) classify the findings that match nothing as TP or FP. It writes `results.json`, `results.details.json`, and a resumable `results.checkpoint.json` while it runs. |
| PR key | `scripts/lib/types.ts` `prKey`: `<owner>_<repo>_<pr_number>-<head[0:8]>`, replacing only the first `/`. Golden files are `golden/<key>.json` with `{pr_key, pr, findings}`, and each golden finding carries `tp_fp`, `severity`, `category` and `producer`. |
| Judge cost | The judge reports no cost of its own. `results.json` has `candidate_usage` (ours, from the optional `usage` field) but no judge spend. |
| Judge input | One JSON file per PR: `{pr: {repo, pr_number, base, head}, agent, findings: [{file, start_line, end_line, message, producer}], usage?}` ([JUDGING_INPUT.md](https://github.com/review-bench/ReviewBench/blob/main/docs/JUDGING_INPUT.md)). Line numbers refer to the file at head. |
| What the judge needs | Node 20+, `npm ci` in a ReviewBench checkout, and a provider key (`ANTHROPIC_API_KEY` for `--provider anthropic`). The leaderboard is judged by **Claude Sonnet 5** (`claude-sonnet-5`). If the bundled model registry lacks it, it goes in a `models.json` under `PI_CODING_AGENT_DIR` ([OFFLINE_EVAL.md](https://github.com/review-bench/ReviewBench/blob/main/docs/OFFLINE_EVAL.md)). |
| Docker | Needed only by `scripts/try-agent.sh` and the leaderboard container contract. We don't need it: the judge accepts findings from any harness ("Already have findings?"). |
| Repo mirrors | Every source repo is mirrored at `review-bench/<owner>_<repo>` with each task's base and head commits (`scripts/extraction/git.ts`, `scripts/try-agent.sh`). The judge clones from those mirrors, and so do we. |
| Leaderboard | Only a final run submitted through the review-bench.ai portal, inside a container, can be published. Offline scores are for tuning only. That portal is **out of scope** here. |

### License conclusion

ReviewBench's own content (manifest, golden findings, judging code) is MIT, so copying it into this repo is allowed with the notice kept. The PR diffs and checkouts, though, are code from 187 upstream repos under their own licenses, which ReviewBench's MIT notice doesn't cover. **Plan: copy nothing.** The harness downloads ReviewBench at the pinned commit and downloads each case's code from its mirror into a gitignored work dir. The case dirs, lens-review's findings and the judge's raw output all stay in the work dir, which is outside this repo. The only file a benchmark run ever commits is `report.mjs`'s markdown table, as `tests/lens-review-eval/reviewbench/results/<run>.md`: aggregate numbers only. `results.details.json` is never committed, because it holds golden messages and judge reasoning that can quote upstream code. That also keeps a single copy of the ReviewBench data, the upstream one, so ours can't drift out of sync.

## How lens-review fits

- **Input.** ReviewBench gives `base`, `head` and the title and body. lens-review's local mode is `/lens-review --base <ref>` with the current directory at head: `gather-diff.sh` diffs `<ref>...HEAD`, which is the same three-dot diff ReviewBench uses, and `--base` accepts a SHA. So the harness checks the mirror out at `head` and runs `/lens-review --base <base>`. PR context then comes from `git log base..HEAD` (the PR's commit messages) rather than the PR body. That's a known gap, and the skill is not changed for it.
- **Step 6 still runs.** With no PR URL, lens-review's Step 6 runs `gh pr view --json url,headRefOid` for the current branch. With no remote (and `gh` disallowed) that fails and the run ends with "Not offered for posting". That is expected. The leak check must not count this one lookup as a leak, or every run would be dropped.
- **Output.** `final-findings.json` holds `[{id, file, line, severity, category, description, reviewer, locations?, skeptic}]`, and the report prints its path on a `Findings JSON:` line. Each kept finding becomes one ReviewBench finding with `start_line = end_line = line` and `message = description`. A merged finding stays one logical issue, as ReviewBench's contract asks, and its other copies are listed in the message ("Also at b.ts:3, c.ts:9").
- **Reusing PR #7's harness.** A materialized case looks like `carpool-pr13/` and `lens-review-pr3/`: `change.patch`, `base.txt`, `runs/<run>.json` (lens-review's kept findings), plus `head.txt` and `pr.json`. ReviewBench's `golden/<key>.json` is stored verbatim as `golden.json` instead of a hand-written `gold.json`, because the judge does semantic matching and `score-recall.mjs`'s file/line/category matching would score against a different rule. Turning golden files into `gold.json` for a free proxy score is a **non-goal** for this plan. It can come later if judge costs start to dominate.

## Design

All new code is eval tooling and lives in `tests/lens-review-eval/reviewbench/`, next to `score-recall.mjs`. The skill under `skills/lens-review/` is not touched. Scripts reuse `skills/lens-review/scripts/lib/cli.mjs` (`fail`, `readJsonFile`, `isRunDirectly`), so every failure goes to stderr as a `lens-review: …` message with a non-zero exit, like the skill's own scripts. The work dir is `$REVIEWBENCH_WORK`, by default `${XDG_CACHE_HOME:-$HOME/.cache}/lens-review-reviewbench`. It's outside this repo for two reasons. First, Claude Code loads every `CLAUDE.md` above its working directory, so a checkout nested in this repo would review with whatever instructions sit above it. Second, the test set alone is 2–5 GB of clones that don't belong in a working tree. It holds the ReviewBench checkout, the cases, `lens-home/` (the `LENS_REVIEW_HOME` for teams cast during the benchmark, so `~/.claude/lens-review` stays untouched), `approval.json`, `ledger.jsonl` and `runs/<run>/`.

| File | Does | Fails loudly on |
|---|---|---|
| `fetch-reviewbench.sh` | Clones ReviewBench at the pinned SHA into the work dir and runs `npm ci`. One constant holds the pin. | A clone or checkout failure, or a SHA mismatch. |
| `cases.mjs` | `prKey(pr)` (ReviewBench's own key formula), `loadSet(rbDir, 'test'\|'full')`, `materializeCase({rbDir, key, casesDir, mirrorUrlTemplate})`, which clones the mirror, checks out head detached, **removes the remote**, and writes `pr.json`, `base.txt`, `head.txt`, `change.patch` and `golden.json`. A CLI wraps it: `--set`, `--pr <key>`. | An unknown set, a key not in the manifest, a missing golden file, a mirror that can't be cloned (the error names the mirror URL). |
| `to-reviewbench.mjs` | `toReviewBenchFindings(finalFindings, pr, agent)`, plus a CLI `--case --findings --out`. | A finding with no file or line (the error names its id), or a `pr.json` without a 40-character base or head. |
| `live-gate.mjs` | `checkGate({kind: 'review'\|'judge', requested, estimateUsd, approval, ledger})` returns `{allowed, reason}`. `estimateUsd` is per unit, so the check is `spent + requested × estimateUsd ≤ maxUsd`. The ledger is append-only JSONL. The CLI has `check`, `reserve` and `end`. `reserve` checks and appends the `start` entry (with `estimatedUsd`) in one step, under an exclusive lock file (`fs.openSync(…, 'wx')`), so two runs started at once can't both fit the last slot. `end` appends `actualUsd`, which is `null` for the judge because it reports no cost. The amount spent counts each run at its actual cost when its `end` carries one, and at its estimate otherwise. So neither a crashed run nor a judge run can hide spend. | No approval, an approval that doesn't cover this kind, a malformed approval, a missing or non-positive estimate, the approved count exceeded, the budget exceeded. |
| `leak-check.mjs` | `findLeaks(streamJsonText)`: flags any WebFetch or WebSearch call, any `mcp__*` tool call, any Bash command that fetches a GitHub URL, any `gh api`, and any `gh` call that names a PR (a URL, a number, or `-R`/`--repo`). Two things are not flagged: `grep github.com` over the repo, and the bare `gh pr view --json …` current-branch lookup from lens-review's Step 6. It flags attempted calls, denied or not, because a denied call still shows the run was trying to look up answers. | A log line that isn't JSON (the error names the line). |
| `run-case.sh <case> <run>` | Refuses a checkout that carries `.claude/settings.json` or `.claude/settings.local.json`; the reasons are under Validity guards. Then it calls `live-gate.mjs reserve` with the estimate `REVIEWBENCH_REVIEW_ESTIMATE_USD`, and runs `claude -p "/lens-review --base <base>"` from inside the checkout. The flags are `--output-format stream-json --verbose --max-budget-usd <estimate>`, `--setting-sources project --strict-mcp-config`, an explicit `--allowedTools` list held in one constant (Read, Grep, Glob, Write, Edit, Agent, SendMessage, and `Bash(git:*)`, `Bash(node:*)`, `Bash(bash:*)`, `Bash(mkdir:*)`, `Bash(cat:*)`; never `bypassPermissions` or `--dangerously-skip-permissions`) and `--disallowedTools "Bash(gh api --method POST:*)" "Bash(gh:*)" WebFetch WebSearch "Bash(curl:*)" "Bash(wget:*)"`, with `LENS_REVIEW_HOME=$WORK/lens-home`. The cap equals the estimate the gate charged, so the ledger's worst case is the real worst case, give or take the last turn's overshoot. It links the lens-review version under test (`LENS_SKILL_DIR`, by default this repo's `skills/lens-review`) into the checkout's `.claude/skills/`, listed in `.git/info/exclude`. Afterwards it records `end` with `total_cost_usd`, checks the log for leaks, checks that the skill which loaded was `LENS_SKILL_DIR`, copies `final-findings.json` to `<case>/runs/<run>.json`, and converts it to `$WORK/runs/<run>/findings/<key>.json`. | A checkout with its own settings, or a gate refusal (claude is never started, nothing is reserved). A leaked run or the wrong skill (the findings are not written, and `end` is still recorded). A missing `Findings JSON:` line. A tool the allowlist lacks, which shows up in the log as a permission denial: run-case names the tool, so the pilot can extend the list. |
| `run-judge.sh <run>` | Reserves through the gate (one judge unit per findings file, at `REVIEWBENCH_JUDGE_ESTIMATE_USD` each), writes `$WORK/.judge/models.json` registering `claude-sonnet-5`, sets `PI_CODING_AGENT_DIR=$WORK/.judge`, then runs `npm --prefix <rb> run judge -- --candidate <run>/findings --provider anthropic --model claude-sonnet-5 --output <run>/scoring/results.json --repo-dir $WORK/judge-repos`. Afterwards it records `end` with `actualUsd: null`. | Gate refusal (npm is never started), or the judge exiting non-zero. |
| `report.mjs` | `summarizeJudgeResults(results, expectedKeys)` returns `{prCount, missingKeys, overall, bySeverity, byCategory, judgeModel}`. A CLI `--results --findings` prints a markdown table. | A missing `results.json` (the message points at the checkpoint if one exists), malformed JSON, a file with no `macro.overall`, and coverage gaps: **a PR with findings but no score fails the report**, because the judge drops it silently instead of counting it as a miss. |

`run-case.sh` and `run-judge.sh` both go through `live-gate.mjs`. That script is the only place the approval rule exists. `CLAUDE_BIN` and `NPM_BIN` exist only so the tests can substitute fakes.

### Validity guards

- **No PR posting.** `Bash(gh api --method POST:*)` is always disallowed, as are all `gh` commands. The checkout has no remote, so Step 6 of lens-review finds no PR and doesn't offer to post.
- **No looking up answers.** ReviewBench warns that its PRs and their review comments are public. Web tools, `gh`, `curl` and `wget` are disallowed, MCP servers aren't loaded (`--strict-mcp-config`), and `leak-check.mjs` scans every run's tool calls, including subagents', in the stream-json log. A run that leaked is dropped, not scored.
- **Only lens-review shapes the review.** `--setting-sources project` keeps out the developer's user settings: their `~/.claude/CLAUDE.md`, plugins and their hooks, the installed `~/.claude/skills/lens-review`, and permission allowlists. Without it, a SessionStart hook or a personal taste file would be scored as if it were lens-review. The reviews still use the `claude` login, unlike `--bare`, which requires an API key.
- **No code from the reviewed repo runs.** `-p` skips the workspace-trust prompt, so a `.claude/settings.json` committed in one of 187 upstream repos would run its hooks on the developer's machine. `run-case.sh` refuses those checkouts by name before reserving anything. If the pilot or the test set turns up many of them, revisit (hide the file with `git update-index --skip-worktree`), but don't silently run them.
- **The right lens-review.** The run fails unless the loaded skill's base dir is `LENS_SKILL_DIR`, so a benchmark can never score the installed copy by mistake.
- **Self-agreement.** 1,434 of the 2,623 golden TPs (55%) came from Claude review agents: 1,206 `llm_review:claude-…` and 228 `ccr:claude-…`. A diagnostic re-judge with `--exclude-producer llm_review:claude --exclude-producer ccr:claude` (the flag is repeatable) shows how much of the score is agreement with Claude's own earlier output. It's optional, and its results are reported separately.

## Cost estimate

Prices: Haiku 5.5 $0.10/$0.50 per MTok (≤100K prompt), Sonnet 5 and 5.5 $2/$10, Opus 5.5 $4/$20.

- **lens-review, per PR.** SKILL.md measures $1.70–2.20 per run (about 0.7–0.8M subagent tokens plus the Opus orchestrator). PR #3 alone used about 1.44M subagent tokens. Almost every ReviewBench PR is a new repo, so add team setup on Opus, $0.50–0.80. That gives **about $2.2–3.0 for a PR under 500 lines and $5–10 for one over 1,000 lines** (Haiku's price rises above 100K prompt tokens). `--max-budget-usd` caps each run.
- **Judge, per PR (Sonnet 5).** The judge reports no spend, so the ledger charges each judge PR its estimate. Revise the estimate from the API key's usage in the Console, not from the ledger. Matching costs under $0.10. Classifying unmatched findings is the bulk: about 5 per PR at roughly 60K input and 3K output tokens each, about $0.75. Total **about $0.5–1.5 per PR**.
- **3-PR pilot** (TechDebtMCP#135, 3 lines; aafactory-prototype#17, 45 lines; gh-copilot-review#9, 68 lines): about $8 for review and $3 for the judge, **about $11**.
- **25-PR test set:** about $60–150 for review and $15–40 for the judge, **about $75–190**.
- **Full set, 219 PRs, one round:** about $600–1,000 for review and $110–330 for the judge, **about $700–1,300**. The leaderboard runs three rounds.

These are estimates. The pilot records the actual cost per run in `ledger.jsonl`, and the estimates get revised from those numbers before any larger approval.

## Live-run gate (part of the plan)

1. No live lens-review run and no judge run happens during planning or dev. Tests use only fakes.
2. Before any live run, the developer writes `$REVIEWBENCH_WORK/approval.json` themselves:
   `{"review": {"count": 3, "maxUsd": 15}, "judge": {"count": 3, "maxUsd": 6}, "approvedOn": "<date>"}`.
   An agent never writes or edits this file.
3. Order: **pilot (3 PRs) → report → developer re-approves → test set (25) → developer re-approves → full set**. Each step gets its own approval, sized from the previous step's actual costs.
4. The gate refuses once the approved count or budget is used up, counting earlier runs in the ledger. Checking and recording a start are one locked `reserve` step, so parallel runs can't overspend.

## What the developer must provide

- An explicit OK, in `approval.json`, on the count and budget for each step.
- `ANTHROPIC_API_KEY` for the judge, ideally a dedicated key with a spending cap. The reviews themselves run through the local `claude` CLI login.
- About 2–5 GB of disk for mirror clones of the test set (one repo is over 100 MB), under the work dir outside this repo.

## Out of scope

- Submitting to the leaderboard (container image, portal onboarding).
- Changing lens-review itself, including how it handles the PR body.
- A proxy scorer that turns golden files into `gold.json` for `score-recall.mjs`.

## Shape

Flat, one PR. The seven files are one harness: the pilot needs all of them, and none of them is useful alone. Merged by itself, it changes no skill code and adds only offline-tested eval tooling, so `npm test` stays green and nothing ships to lens-review's users.

## Verifier

`npm test` (`node --test tests/*.test.mjs`). The QA spec is `tests/lens-review-reviewbench.test.mjs`. It's red now: 48 tests, all failing. The module tests fail with `ERR_MODULE_NOT_FOUND`. The script tests fail because bash can't find `run-case.sh` or `run-judge.sh`, and every refusal test also requires the harness's own `lens-review:` message, so a missing script can't pass one by accident. The other 288 tests stay green. dev must see it fail first, then make it pass one behavior at a time using red-green-refactor.

## QA cases (all in the QA spec)

- **Case adapter:** ReviewBench's key formula; loading the test set and the full set; materializing a case at head with no remote and `change.patch` equal to `base...head`; refusing an unknown key, a missing golden file or a missing mirror.
- **Converter:** the field mapping; a merged finding with its other copies listed in the message; stripping a leading `./`; an empty review; refusing a finding with no line or a short head.
- **Gate:** allowing a run within the approval; refusing no approval, a kind the approval doesn't cover, a malformed approval, a missing or non-positive estimate, an exceeded count, an exceeded budget (with a crashed run, and a judge run with no actual cost, charged their estimates); `reserve` recording the start in the same step as the check; the CLI's exit code.
- **Leak check:** a clean run passes, and so does lens-review's own current-branch `gh pr view`; GitHub fetches, `gh` calls that name a PR or repo, web tools and MCP tools are flagged; a non-JSON log line is refused.
- **Report:** the summary; null metrics stay null; missing PRs are listed; a file that isn't a results file is refused; the CLI's missing-file (with a pointer to the checkpoint), malformed-file and coverage-gap exits.
- **Runner:** refuses before starting claude, both with no approval and with a checkout that carries `.claude/settings.json`; passes the arguments that block posting and the web, `--setting-sources project` and `--strict-mcp-config`, the budget cap equal to the gate's estimate, no permission bypass, `LENS_REVIEW_HOME` and the working directory; saves findings, the converted file and the actual cost; refuses once the count is used up; drops a run that leaked or loaded the wrong skill.
- **Judge runner:** refuses before starting npm; passes the leaderboard judge model, the arguments and the `models.json`; refuses when there are more findings files than the approved count.
