# ReviewBench as the benchmark for lens-review

**QA Spec:** `tests/lens-review-reviewbench.test.mjs`

## Summary

This plan makes ReviewBench, an open benchmark of 219 real PRs with reference findings and an LLM judge, the yardstick for lens-review. It does so the way ReviewBench asks every reviewer to: with a thin container adapter that satisfies ReviewBench's agent contract. ReviewBench's own `scripts/try-agent.sh` fetches each PR from its mirrors, runs the container once per PR and checks the findings file, and ReviewBench's own judge scores the results. This repo adds only the adapter: a Dockerfile, an entrypoint that runs lens-review headless and writes the findings file, and the converter between the two formats. The container keeps your own Claude Code setup and the reviewed repo's code off your machine's execution path, and every run is capped by a per-PR budget. The first live step after merge is a 3-PR pilot, about $11, which you run yourself.

## Why a container adapter

Planning first designed a host-side harness of seven files: a case fetcher, two runners, an approval file with a cost ledger, a leak check and a report script. Plan review replaced it with this design. The host-side harness duplicated what ReviewBench already ships, and most of its extra machinery existed only to undo the downsides of running on the host:

- **Isolation comes free.** In a fresh container, `claude` has no `~/.claude/CLAUDE.md`, plugins, hooks, MCP servers or a second installed copy of lens-review. An upstream repo's `.claude/settings.json` hooks run inside a throwaway container, not on your machine.
- **Fetching and checking come free.** `try-agent.sh` clones from the `review-bench/<owner>_<repo>` mirrors, checks out head, computes the three-dot diff, writes `pr.json`, validates our findings file and copies it to `findings/<key>.json`.
- **It's the leaderboard's path.** The same image can later be registered in the portal unchanged, which is out of scope here.
- **Spend control already exists.** ReviewBench recommends a dedicated API key with a spend cap. On top of that, the adapter refuses to start without a per-PR budget and passes it to `claude --max-budget-usd`. That replaces the approval file and ledger.

What we give up is running under your `claude` login. In the container, Claude Code authenticates with `ANTHROPIC_API_KEY`, passed in with `try-agent.sh -e ANTHROPIC_API_KEY` and never baked into the image. Docker is needed too. Both are installed on this machine (Docker 29.9, jq 1.7).

## Verified facts about ReviewBench

Checked against https://github.com/review-bench/ReviewBench at commit `36d10aea5cd9d40d1a564c0e6a0d84ca814a872c` (2026-10-23), re-checked by plan review on 2026-10-24.

| Claim | Verified |
|---|---|
| Maintainer | The `review-bench` GitHub organization. The README says "developed by GitHub"; nothing beyond the README confirms it. |
| License | MIT, © 2026 review-bench. |
| Corpus | `corpus/manifest.json`: 219 PRs from 187 repos. `golden/`: 219 files `{pr_key, pr, findings}`, 4,632 findings (2,623 TP), each with `tp_fp`, `severity`, `category` and `producer`. |
| Test set | `corpus/test/test.json`: 25 PRs, 13 languages. 7 change more than 1,000 lines (the largest, simnaut/emdash#2, 14,642). |
| Agent contract | `AGENT_CONTRACT.md`. The container gets the checkout at head at `/work/repo` (with `.git`, base reachable, `origin` set to the mirror), `/work/pr/diff.patch`, `/work/pr/pr.json` and `RB_NWO`, `RB_PR_NUMBER`, `RB_BASE`, `RB_HEAD`, `RB_AGENT`, `RB_OUT`, plus `RB_CONFIG_<KEY>` for configuration labels. It writes one JSON file at `RB_OUT`: `{pr: {repo, pr_number, base, head}, agent, findings: [{file, start_line, end_line, message, producer}], usage?}`. Exit 0 with a valid file is accepted, and `"findings": []` is a valid review. A non-zero exit or a bad file fails the PR. The image runs with no arguments on `linux/amd64`, with 30 minutes per PR by default. It should print the configuration it applied. |
| try-agent.sh | `scripts/try-agent.sh <image> [--set test\|full] [--pr <index>] [-e NAME[=VALUE] ...]`. Needs docker, git and jq. Mirrors are cached under `$TRY_AGENT_WORK`, and validated findings land in `./findings/<key>.json`. It passes `RB_AGENT=try-agent`. |
| Judge | `npm run judge -- --candidate <dir> --provider anthropic --model claude-sonnet-5 --output <results.json>`, plus `--repo-dir`, `--limit`, `--concurrency` and the repeatable `--exclude-producer <prefix>`. Strict by default: it refuses to write partial results. It reports no cost of its own. The leaderboard judge is Claude Sonnet 5. If pi's bundled registry lacks it, it goes in `models.json` under `PI_CODING_AGENT_DIR` (`docs/OFFLINE_EVAL.md`). |
| Network | The leaderboard enforces an egress allowlist. `try-agent.sh` does not, so locally the container has an open network. |

### License conclusion

Nothing from ReviewBench or the 187 upstream repos is copied into this repo. `try-agent.sh` fetches cases into its own work dir, outside this repo. The only benchmark output that may be committed is an aggregate scores table under `tests/lens-review-eval/reviewbench/results/<run>.md`. `results.details.json` is never committed, because it holds golden messages and judge reasoning that can quote upstream code.

## How lens-review fits

- **Input.** lens-review's local mode is `/lens-review --base <ref>` from inside the checkout. `gather-diff.sh` diffs `<ref>...HEAD`, the same three-dot diff as `diff.patch`, and `--base` accepts a SHA. So the adapter runs `/lens-review --base $RB_BASE` in `/work/repo`. PR context comes from `git log base..HEAD` rather than `pr.json`'s title and body. That's a known gap, and lens-review is not changed for it.
- **Step 6 needs nothing.** The image has no `gh`, and `Bash(gh:*)` is disallowed anyway, so Step 6's `gh pr view` fails and the run ends "Not offered for posting". No run can post to a PR.
- **Output.** `final-findings.json` holds `[{id, file, line, severity, category, description, reviewer, locations?, skeptic}]`, and the report prints its path on a `Findings JSON:` line. Each kept finding becomes one ReviewBench finding with `start_line = end_line = line` and `message = description`. A merged finding stays one logical issue, as the contract asks, and its other copies are named in the message ("Also at src/b.ts:3, src/c.ts:9").
- **PR #7's eval layout.** The eval cases under `tests/lens-review-eval/` are hand-built `change.patch` + `gold.json` cases scored by `score-recall.mjs`'s file/line/category matching. ReviewBench's judge matches semantically, so its cases stay in ReviewBench's own layout under `try-agent.sh`'s work dir and are scored by its judge. The adapter lives next to the other eval tooling, in `tests/lens-review-eval/reviewbench/`, and adds no second case format or scorer here. Turning golden files into `gold.json` for a free proxy score is a non-goal.

## Design

All new files are in `tests/lens-review-eval/reviewbench/`. `skills/lens-review/` is not touched.

| File | Does | Fails loudly on |
|---|---|---|
| `to-reviewbench.mjs` | `toReviewBenchFindings(finalFindings, pr, agent, usage?)` → the contract's JSON. Strips a leading `./`, maps the fields, names merged copies in the message, passes `usage` (`cost_usd`, `time_in_ms`) through when given. | A finding with no file or line (the error names its id), and a `pr` without a 40-character base or head. |
| `agent.mjs` | The container's entrypoint, in the shape of ReviewBench's `examples/codex-cli/agent.mjs`. (1) It checks `RB_NWO`, `RB_PR_NUMBER`, `RB_BASE`, `RB_HEAD`, `RB_OUT`, `ANTHROPIC_API_KEY` and `RB_CONFIG_MAX_BUDGET_USD`, which must be a positive number, and checks that the checkout's `HEAD` is `RB_HEAD`. (2) It prints the applied settings, `model=<m> max_budget_usd=<n>`, as the contract asks. (3) It runs `claude -p "/lens-review --base $RB_BASE"` in `RB_REPO` (default `/work/repo`) with `--model` (from `RB_CONFIG_MODEL`, default `claude-opus-5-5`, which is what lens-review's measured costs assume), `--output-format stream-json --verbose --max-budget-usd <n> --dangerously-skip-permissions`, and `--disallowedTools WebFetch WebSearch "Bash(gh:*)" "Bash(curl:*)" "Bash(wget:*)"`. Its environment adds a fresh `LENS_REVIEW_HOME` under the temp dir, `DISABLE_TELEMETRY=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. (4) It saves the stream log next to `RB_OUT` as `lens-review.log`, reads the result event, reads the file on its `Findings JSON:` line, and writes `RB_OUT` with `usage: {cost_usd: total_cost_usd, time_in_ms: duration_ms}`. `CLAUDE_BIN` exists only so the tests can substitute a fake. | Every failure goes through `skills/lens-review/scripts/lib/cli.mjs`'s `fail`, as a `lens-review: …` message with a non-zero exit, and no `RB_OUT` is written: a missing or invalid variable (claude is never started), a checkout at the wrong commit, claude exiting non-zero, a result event that isn't `success` (for example the budget cap), and no `Findings JSON:` line. |
| `Dockerfile` | `FROM node:22-slim`. It installs `git` and `ca-certificates` (no `gh`, no `curl`) and `@anthropic-ai/claude-code` at one exact version (2.1.310 at planning time). It copies `skills/lens-review` to `/home/node/.claude/skills/lens-review` and the two `.mjs` files to `/agent/`, then `USER node` (Claude Code refuses `--dangerously-skip-permissions` as root) and `ENTRYPOINT ["node", "/agent/agent.mjs"]`. The build context is the repo root, so the skill can be copied: `docker build --platform linux/amd64 -f tests/lens-review-eval/reviewbench/Dockerfile -t lens-review-reviewbench:dev .`. | |
| `Dockerfile.dockerignore` | BuildKit's per-Dockerfile ignore file. It excludes everything except `skills/lens-review/` and this directory's `.mjs` files, so `.git`, `node_modules` and local files never enter the image. | |

`--dangerously-skip-permissions` is safe here for the same reason ReviewBench's Codex example bypasses its sandbox: the container is the sandbox, and the checkout is discarded after the run. The deny list still applies on top of it. lens-review needs Bash, Write and Agent freely, and an allowlist that misses one tool would fail a PR halfway through a paid run.

### Validity guards

- **No PR posting.** There's no `gh` in the image, `Bash(gh:*)` is disallowed, and the checkout's `origin` is a ReviewBench mirror, not the PR.
- **No looking up answers.** ReviewBench warns that its PRs and their review comments are public. Web tools, `gh`, `curl` and `wget` are disallowed. Locally the network is otherwise open (the leaderboard's egress allowlist would close it), so the pilot's `lens-review.log` files are checked by hand for any attempt. This is a manual check because a disallowed tool can't run; it's not an automated leak scanner.
- **The right lens-review.** The image holds exactly one copy, the one it was built from, so the image tag names the version under test.
- **Self-agreement.** 1,434 of the 2,623 golden TPs (55%) came from Claude review agents: 1,206 `llm_review:claude-…` and 228 `ccr:claude-…`. A diagnostic re-judge with `--exclude-producer llm_review:claude --exclude-producer ccr:claude` shows how much of the score is agreement with Claude's own earlier reviews. It's optional, and its results are reported separately.

## Cost estimate

Prices: Haiku 5.5 $0.10/$0.50 per MTok (≤100K prompt, $0.50/$2.50 above), Sonnet 5 and 5.5 $2/$10, Opus 5.5 $4/$20.

- **lens-review, per PR.** lens-review's README measures $1.70–2.20 per run. Every container starts with an empty `LENS_REVIEW_HOME`, so every PR also pays for casting on Opus, $0.50–0.80. That gives **about $2.2–3.0 for a PR under 500 lines and $5–10 for one over 1,000 lines**.
- **Judge, per PR (Sonnet 5).** Matching costs under $0.10. Classifying unmatched findings is the bulk: about 5 per PR at roughly 60K input and 3K output tokens each, about $0.75. Total **about $0.5–1.5 per PR**. The judge reports no spend, so read it from the key's usage in the Console.
- **3-PR pilot**: test-set indices 0 (PierreJanineh/TechDebtMCP#135, 3 lines), 4 (AA-Factory/aafactory-prototype#17, 45 lines) and 9 (k1LoW/gh-copilot-review#9, 68 lines). About $8 for review and $3 for the judge, **about $11**.
- **25-PR test set:** about $60–150 for review and $15–40 for the judge, **about $75–190**.
- **Full set, 219 PRs, one round:** about $600–1,000 for review and $110–330 for the judge, **about $700–1,300**.

The pilot records each PR's actual cost as `usage.cost_usd` in its findings file. Revise these estimates from those numbers before any larger run.

## Live runs (after merge, by the developer only)

1. No live review and no judge run happens during planning, dev or QA. The QA spec uses a fake `claude`. Dev may run `docker build` to check that the image builds (no API spend), but never `try-agent.sh` or the judge.
2. The developer runs every live step themselves, from a ReviewBench checkout at the pinned commit (`git clone https://github.com/review-bench/ReviewBench && git -C ReviewBench checkout 36d10aea && npm --prefix ReviewBench ci`):

   ```sh
   docker build --platform linux/amd64 -f tests/lens-review-eval/reviewbench/Dockerfile -t lens-review-reviewbench:dev .
   cd ReviewBench && mkdir -p runs/pilot && cd runs/pilot
   for i in 0 4 9; do
     TRY_AGENT_WORK=$HOME/.cache/reviewbench-try-agent ../../scripts/try-agent.sh lens-review-reviewbench:dev --pr $i \
       -e ANTHROPIC_API_KEY -e RB_CONFIG_MAX_BUDGET_USD=4
   done
   cd ../.. && mkdir -p .judge   # models.json per docs/OFFLINE_EVAL.md, registering claude-sonnet-5
   PI_CODING_AGENT_DIR=$PWD/.judge npm run judge -- --candidate runs/pilot/findings \
     --provider anthropic --model claude-sonnet-5 --output runs/pilot/scoring/results.json
   ```

3. Order: **pilot (3 PRs) → read the scores and costs → test set (25) → decide → full set**. Use a fresh run dir each time so findings never mix.
4. Use a dedicated `ANTHROPIC_API_KEY` with a spend cap sized to the step, as ReviewBench recommends. With `RB_CONFIG_MAX_BUDGET_USD` on every PR, the cap is the hard ceiling and the budget is the per-PR one.

## What the developer must provide

- A dedicated `ANTHROPIC_API_KEY` with a spend cap. It's used for both the reviews and the judge.
- Running the steps above themselves, one step at a time.
- About 2–5 GB of disk for the mirror cache of the test set, under `TRY_AGENT_WORK`, outside this repo.

## Out of scope

- Registering the image on the leaderboard (pushing to GHCR, portal onboarding, an egress list).
- Changing lens-review itself, including how it handles the PR body.
- A proxy scorer that turns golden files into `gold.json` for `score-recall.mjs`.
- A wrapper around the judge or a report script. The judge prints its own summary. The scores table under `results/` is written by hand from `results.json` after a run.

## Shape

Flat, one PR. The adapter is four small files that only work together. Merged by itself, it changes no skill code and adds only offline-tested eval tooling, so `npm test` stays green and nothing ships to lens-review's users. It also adds a short "Benchmark (ReviewBench)" paragraph to the README's `## Tests` section, pointing at this plan's live-run steps, next to the existing `RUN_LIVE_EVAL=1` note.

## Verifier

`npm test` (`node --test tests/*.test.mjs`). The QA spec is `tests/lens-review-reviewbench.test.mjs`, which is red now. The converter and agent tests fail with `ERR_MODULE_NOT_FOUND`. The image tests fail because the Dockerfile doesn't exist. Every refusal test requires the adapter's own `lens-review:` message, so a missing file can't pass one by accident. dev must see it fail first, then make it pass one behavior at a time using red-green-refactor. `docker build` is the second check: dev runs it once, and it costs no API spend.

## QA cases (all in the QA spec)

- **Converter:** the field mapping; a merged finding with its other copies named in the message; stripping a leading `./`; an empty review; passing usage through; refusing a finding with no line, or a short head.
- **Agent, refusals before claude starts:** no budget, a zero or non-numeric budget, no API key, a missing `RB_OUT`, a checkout whose `HEAD` isn't `RB_HEAD`.
- **Agent, a run:** runs lens-review headless against `RB_BASE` from the checkout, with the model, the budget cap, stream-json, the deny list and a fresh `LENS_REVIEW_HOME`; prints the applied settings; writes `RB_OUT` in the contract's shape with `RB_AGENT`, the head, the PR number and `usage.cost_usd`; saves `lens-review.log`; an empty review is `"findings": []` with exit 0.
- **Agent, failures (no `RB_OUT` written):** claude exits non-zero; the result isn't `success` (the budget cap); no `Findings JSON:` line.
- **Image:** pins Claude Code to an exact version; installs no `gh`; copies the skill into the node user's skills; runs as `node`; its entrypoint is `agent.mjs`; the ignore file keeps `.git` and `node_modules` out.
