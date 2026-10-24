# ReviewBench as the benchmark for lens-review

## Summary

This plan makes ReviewBench, an open benchmark of 219 real PRs with reference findings and an LLM judge, the yardstick for lens-review. A small harness under `tests/lens-review-eval/reviewbench/` downloads ReviewBench cases into PR #7's eval-case layout, runs lens-review on each one headless, converts the kept findings into ReviewBench's judging format, and reads the judge's scores. ReviewBench's own judge replaces our hand-built answer keys, so lens-review gets scored against reference findings someone else wrote. Every live review and judge run sits behind an approval file with a count and a budget, and the first step after merge is a 3-PR pilot, about $11.

**QA Spec:** `tests/lens-review-reviewbench.test.mjs`

## Verified facts about ReviewBench

Checked against https://github.com/review-bench/ReviewBench at commit `36d10aea5cd9d40d1a564c0e6a0d84ca814a872c` (2026-10-23).

| Claim | Verified |
|---|---|
| Maintainer | The `review-bench` GitHub organization (created 2026-09-04). The README says "developed by GitHub"; I found nothing beyond the README that confirms GitHub's involvement. |
| License | MIT, © 2026 review-bench ([LICENSE](https://github.com/review-bench/ReviewBench/blob/main/LICENSE)). |
| 219 PRs from 187 repos | Yes: `corpus/manifest.json` has 219 entries and 187 distinct repos. `golden/` has 219 files with 4,632 labeled findings (TP and FP). |
| 25-PR test set | `corpus/test/test.json` (25 manifest entries), with `picks.md` explaining each pick. 13 languages; 7 of the 25 PRs change more than 1,000 lines (the largest, simnaut/emdash#2, changes 14,642). |
| Metrics | Grounded and augmented precision and recall, macro and micro, broken down by severity (high/medium/low) and category (correctness, reliability, maintainability, testing, security, documentation, performance, api-architecture, accessibility). See [METHODOLOGY.md §7](https://github.com/review-bench/ReviewBench/blob/main/docs/METHODOLOGY.md). |
| Judging CLI | `npm run judge -- --candidate <file or dir> --provider <p> --model <id> --output <results.json> [--repo-dir] [--limit] [--concurrency]` ([JUDGING.md](https://github.com/review-bench/ReviewBench/blob/main/docs/JUDGING.md)). It uses an LLM to match our findings to the golden ones within each file, then has an agent (with read access to the repo) classify the findings that match nothing as TP or FP. It writes `results.json`, `results.details.json`, and a resumable `results.checkpoint.json` while it runs. |
| Judge input | One JSON file per PR: `{pr: {repo, pr_number, base, head}, agent, findings: [{file, start_line, end_line, message, producer}], usage?}` ([JUDGING_INPUT.md](https://github.com/review-bench/ReviewBench/blob/main/docs/JUDGING_INPUT.md)). Line numbers refer to the file at head. |
| What the judge needs | Node 20+, `npm ci` in a ReviewBench checkout, and a provider key (`ANTHROPIC_API_KEY` for `--provider anthropic`). The leaderboard is judged by **Claude Sonnet 5** (`claude-sonnet-5`). If the bundled model registry lacks it, it goes in a `models.json` under `PI_CODING_AGENT_DIR` ([OFFLINE_EVAL.md](https://github.com/review-bench/ReviewBench/blob/main/docs/OFFLINE_EVAL.md)). |
| Docker | Needed only by `scripts/try-agent.sh` and the leaderboard container contract. We don't need it: the judge accepts findings from any harness ("Already have findings?"). |
| Repo mirrors | Every source repo is mirrored at `review-bench/<owner>_<repo>` with each task's base and head commits. The judge clones from those mirrors, and so do we. |
| Leaderboard | Only a final run submitted through the review-bench.ai portal, inside a container, can be published. Offline scores are for tuning only. That portal is **out of scope** here. |

### License conclusion

ReviewBench's own content (manifest, golden findings, judging code) is MIT, so copying it into this repo is allowed with the notice kept. The PR diffs and checkouts, though, are code from 187 upstream repos under their own licenses, which ReviewBench's MIT notice doesn't cover. **Plan: copy nothing.** The harness downloads ReviewBench at the pinned commit and downloads each case's code from its mirror into a gitignored work dir. The only files we commit are our own outputs: lens-review's findings (our text, quoting file paths and line numbers) and the judge's score files. That also keeps a single copy of the ReviewBench data, the upstream one, so ours can't drift out of sync.

## How lens-review fits

- **Input.** ReviewBench gives `base`, `head` and the title and body. lens-review's local mode is `/lens-review --base <ref>` with the current directory at head: `gather-diff.sh` diffs `<ref>...HEAD`, which is the same three-dot diff ReviewBench uses, and `--base` accepts a SHA. So the harness checks the mirror out at `head` and runs `/lens-review --base <base>`. PR context then comes from `git log base..HEAD` (the PR's commit messages) rather than the PR body. That's a known gap, and the skill is not changed for it.
- **Output.** `final-findings.json` holds `[{id, file, line, severity, category, description, reviewer, locations?, skeptic}]`, and the report prints its path on a `Findings JSON:` line. Each kept finding becomes one ReviewBench finding with `start_line = end_line = line` and `message = description`. A merged finding stays one logical issue, as ReviewBench's contract asks, and its other copies are listed in the message ("Also at b.ts:3, c.ts:9").
- **Reusing PR #7's harness.** A materialized case looks like `carpool-pr13/` and `lens-review-pr3/`: `change.patch`, `base.txt`, `runs/<run>.json` (lens-review's kept findings), plus `head.txt` and `pr.json`. ReviewBench's `golden/<key>.json` is stored verbatim as `golden.json` instead of a hand-written `gold.json`, because the judge does semantic matching and `score-recall.mjs`'s file/line/category matching would score against a different rule. Turning golden files into `gold.json` for a free proxy score is a **non-goal** for this plan. It can come later if judge costs start to dominate.

## Design

All new code is eval tooling and lives in `tests/lens-review-eval/reviewbench/`, next to `score-recall.mjs`. The skill under `skills/lens-review/` is not touched. Scripts reuse `skills/lens-review/scripts/lib/cli.mjs` (`fail`, `readJsonFile`, `isRunDirectly`), so every failure goes to stderr as a `lens-review: …` message with a non-zero exit, like the skill's own scripts. The work dir is `$REVIEWBENCH_WORK`, by default `tests/lens-review-eval/reviewbench/.work/` (gitignored). It holds the ReviewBench checkout, the cases, `lens-home/` (the `LENS_REVIEW_HOME` for teams cast during the benchmark, so `~/.claude/lens-review` stays untouched), `approval.json`, `ledger.jsonl` and `runs/<run>/`.

| File | Does | Fails loudly on |
|---|---|---|
| `fetch-reviewbench.sh` | Clones ReviewBench at the pinned SHA into the work dir and runs `npm ci`. One constant holds the pin. | A clone or checkout failure, or a SHA mismatch. |
| `cases.mjs` | `prKey(pr)` (ReviewBench's own key formula), `loadSet(rbDir, 'test'\|'full')`, `materializeCase({rbDir, key, casesDir, mirrorUrlTemplate})`, which clones the mirror, checks out head detached, **removes the remote**, and writes `pr.json`, `base.txt`, `head.txt`, `change.patch` and `golden.json`. A CLI wraps it: `--set`, `--pr <key>`. | An unknown set, a key not in the manifest, a missing golden file, a mirror that can't be cloned (the error names the mirror URL). |
| `to-reviewbench.mjs` | `toReviewBenchFindings(finalFindings, pr, agent)`, plus a CLI `--case --findings --out`. | A finding with no file or line (the error names its id), or a `pr.json` without a 40-character base or head. |
| `live-gate.mjs` | `checkGate({kind: 'review'\|'judge', requested, estimateUsd, approval, ledger})` returns `{allowed, reason}`. A CLI provides `check` and `record` (append-only JSONL: a `start` entry with `estimatedUsd` before launch, an `end` entry with `actualUsd` after). The amount spent counts each run at its actual cost, or at its estimate if it never finished, so a crashed run can't hide spend. | No approval, an approval that doesn't cover this kind, a malformed approval, the approved count exceeded, the budget exceeded. |
| `leak-check.mjs` | `findLeaks(streamJsonText)`: flags any WebFetch or WebSearch call, and any Bash command that fetches a GitHub URL or calls `gh api`/`gh pr`. A `grep github.com` over the repo is not flagged. | A log line that isn't JSON (the error names the line). |
| `run-case.sh <case> <run>` | Checks the gate, records `start`, then runs `claude -p "/lens-review --base <base>"` from inside the checkout with `--output-format stream-json --verbose --max-budget-usd <cap>` and `--disallowedTools "Bash(gh api --method POST:*)" "Bash(gh:*)" WebFetch WebSearch "Bash(curl:*)" "Bash(wget:*)"`, and `LENS_REVIEW_HOME=$WORK/lens-home`. It links the lens-review version under test (`LENS_SKILL_DIR`, by default this repo's `skills/lens-review`) into the checkout's `.claude/skills/`, listed in `.git/info/exclude`. Afterwards it records `end` with `total_cost_usd`, checks the log for leaks, checks that the skill which loaded was `LENS_SKILL_DIR`, copies `final-findings.json` to `<case>/runs/<run>.json`, and converts it to `$WORK/runs/<run>/findings/<key>.json`. | Gate refusal (claude is never started), a leaked run or the wrong skill (the findings are not written), a missing `Findings JSON:` line. |
| `run-judge.sh <run>` | Checks the gate (one judge unit per findings file), writes `$WORK/.judge/models.json` registering `claude-sonnet-5`, then runs `npm --prefix <rb> run judge -- --candidate <run>/findings --provider anthropic --model claude-sonnet-5 --output <run>/scoring/results.json --repo-dir $WORK/judge-repos`. | Gate refusal (npm is never started), or the judge exiting non-zero. |
| `report.mjs` | `summarizeJudgeResults(results, expectedKeys)` returns `{prCount, missingKeys, overall, bySeverity, byCategory, judgeModel}`. A CLI `--results --findings` prints a markdown table. | A missing `results.json` (the message points at the checkpoint if one exists), malformed JSON, a file with no `macro.overall`, and coverage gaps: **a PR with findings but no score fails the report**, because the judge drops it silently instead of counting it as a miss. |

`run-case.sh` and `run-judge.sh` both go through `live-gate.mjs`. That script is the only place the approval rule exists. `CLAUDE_BIN` and `NPM_BIN` exist only so the tests can substitute fakes.

### Validity guards

- **No PR posting.** `Bash(gh api --method POST:*)` is always disallowed, as are all `gh` commands. The checkout has no remote, so Step 6 of lens-review finds no PR and doesn't offer to post.
- **No looking up answers.** ReviewBench warns that its PRs and their review comments are public. Web tools, `gh`, `curl` and `wget` are disallowed, and `leak-check.mjs` scans every run's tool calls, including subagents', in the stream-json log. A run that leaked is dropped, not scored.
- **The right lens-review.** The run fails unless the loaded skill's base dir is `LENS_SKILL_DIR`, so a benchmark can never score the installed copy by mistake.
- **Self-agreement.** About half of the golden TPs came from Claude review agents (`llm_review:claude-…`). A diagnostic re-judge with `--exclude-producer llm_review:` shows how much of the score is agreement with Claude's own earlier output. It's optional, and its results are reported separately.

## Cost estimate

Prices: Haiku 5.5 $0.10/$0.50 per MTok (≤100K prompt), Sonnet 5 and 5.5 $2/$10, Opus 5.5 $4/$20.

- **lens-review, per PR.** SKILL.md measures $1.70–2.20 per run (about 0.7–0.8M subagent tokens plus the Opus orchestrator). PR #3 alone used about 1.44M subagent tokens. Almost every ReviewBench PR is a new repo, so add team setup on Opus, $0.50–0.80. That gives **about $2.2–3.0 for a PR under 500 lines and $5–10 for one over 1,000 lines** (Haiku's price rises above 100K prompt tokens). `--max-budget-usd` caps each run.
- **Judge, per PR (Sonnet 5).** Matching costs under $0.10. Classifying unmatched findings is the bulk: about 5 per PR at roughly 60K input and 3K output tokens each, about $0.75. Total **about $0.5–1.5 per PR**.
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
4. The gate refuses once the approved count or budget is used up, counting earlier runs in the ledger.

## What the developer must provide

- An explicit OK, in `approval.json`, on the count and budget for each step.
- `ANTHROPIC_API_KEY` for the judge, ideally a dedicated key with a spending cap. The reviews themselves run through the local `claude` CLI login.
- About 2–5 GB of disk for mirror clones of the test set (one repo is over 100 MB).

## Out of scope

- Submitting to the leaderboard (container image, portal onboarding).
- Changing lens-review itself, including how it handles the PR body.
- A proxy scorer that turns golden files into `gold.json` for `score-recall.mjs`.

## Verifier

`npm test` (`node --test tests/*.test.mjs`). The QA spec is `tests/lens-review-reviewbench.test.mjs`. It's red now, failing with `ERR_MODULE_NOT_FOUND` for every harness module. dev must see it fail first, then make it pass one behavior at a time using red-green-refactor.

## QA cases (all in the QA spec)

- **Case adapter:** ReviewBench's key formula; loading the test set and the full set; materializing a case at head with no remote and `change.patch` equal to `base...head`; refusing an unknown key, a missing golden file or a missing mirror.
- **Converter:** the field mapping; a merged finding with its other copies listed in the message; stripping a leading `./`; an empty review; refusing a finding with no line or a short head.
- **Gate:** allowing a run within the approval; refusing no approval, a kind the approval doesn't cover, a malformed approval, an exceeded count, an exceeded budget (with a crashed run charged its estimate); the CLI's exit code.
- **Leak check:** a clean run passes; GitHub fetches and web tools are flagged; a non-JSON log line is refused.
- **Report:** the summary; null metrics stay null; missing PRs are listed; a file that isn't a results file is refused; the CLI's missing-file (with a pointer to the checkpoint), malformed-file and coverage-gap exits.
- **Runner:** refuses before starting claude; passes the arguments that block posting and the web, plus the budget cap, `LENS_REVIEW_HOME` and the working directory; saves findings, the converted file and the actual cost; refuses once the count is used up; drops a run that leaked or loaded the wrong skill.
- **Judge runner:** refuses before starting npm; passes the leaderboard judge model, the arguments and the `models.json`; refuses when there are more findings files than the approved count.
