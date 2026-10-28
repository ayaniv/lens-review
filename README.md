<p align="center">
  <img src="assets/logo-light.png#gh-light-mode-only" alt="Lens Review" width="300">
  <img src="assets/logo-dark.png#gh-dark-mode-only" alt="Lens Review" width="300">
</p>

# lens-review

A [Claude Code](https://claude.com/claude-code) skill that reviews a branch or PR with a synthetic team of reviewer personas, so it needs no PR-comment history. The first time you run it in a repo, it casts a team from the repo's layout and its own AGENTS.md / CLAUDE.md / Cursor / Copilot rules, and saves that team for later runs. On each review it picks the panel from what the PR changes. Five core personas (Architect, Maintainer, Reliability Engineer, Domain Expert, Reuse Scout) review every PR. The backend, design-system, data and infra personas join only when the PR touches their concern: a changed file is in their area, or a changed line anywhere looks like their concern (for example, an app overriding a design-system component's style). Deterministic pre-checks add the findings a script can be sure of, a Sonnet deep-pass reviewer reads the whole diff, and an Opus skeptic decides which findings make the final report.

## Install

```bash
git clone https://github.com/ayaniv/lens-review.git ~/Dev/lens-review
ln -s ~/Dev/lens-review/skills/lens-review ~/.claude/skills/lens-review
```

Requires `git`, Node.js 20+, and `gh` if you want to review a GitHub PR by URL. A `git pull` in the clone updates the skill.

## Usage

Run from inside the repo you want reviewed:

```
/lens-review                                   # current branch vs the default branch
/lens-review --base develop                    # current branch vs another base ref
/lens-review https://github.com/org/repo/pull/123   # a GitHub PR
/lens-review --plan ../tasks/x/tech-design.md  # also check the PR against a plan it doesn't carry
/lens-review --context pr-description.md      # hold the code to what the PR's description promises
/lens-review --taste ~/.claude/CLAUDE.md --recast  # cast your own engineering taste into the team
/lens-review --recast                          # throw away the saved team and cast a fresh one
```

The base defaults to the remote's default branch, then a local `main`, then `master`.

**Your own taste (opt-in).** `--taste <path>` adds your personal rules file, e.g. the "engineering taste" section of `~/.claude/CLAUDE.md`, to the rule sources the team is cast from. Each of its rules lands in the persona that owns that lens, marked `(source: taste)`, and the repo's own rules win where the two conflict. To set it once, export `LENS_REVIEW_TASTE=<path>`; `--taste` overrides it. Nothing else under `~/.claude` is ever read. The taste is baked into the team when it's cast, so after changing which taste file you use (or editing it), run once with `--recast`.

A plan or intent doc the PR adds or changes (`INTENT.md`, `tech-design*.md`, `design*.md`, `plan*.md`, `spec*.md`) is found on its own. The Domain Expert, the Data Steward and the skeptic read it, so a PR that overtakes a sibling milestone is judged against that plan. A plan the PR writes for itself is only context, though: the skeptic drops a finding for what a plan asks only when that plan came in through `--plan`, and never drops a correctness or security finding on a plan's say-so.

**The PR's description (optional).** `--context <path>` hands every reviewer and the skeptic the PR's description, or any other text saying what the PR is meant to do, ahead of the commit messages, so a change that doesn't do what it promises can be flagged. A review of a PR URL already reads the PR's title and body, so pass `--context` there only for intent beyond them.

**Posting to the PR.** When the review is of an open GitHub PR, it shows you exactly what it would post and asks whether to post it there. That covers a PR you passed by URL, and a branch you reviewed that already has an open PR. Answer no and it stays in your terminal. If you answer yes:

- Each finding becomes an inline comment on its line. The summary, strengths and verdict make up the review body.
- A finding whose line isn't part of the PR's diff is listed in the body instead, so nothing is dropped.
- It always posts as a plain **Comment** review, never Approve or Request changes.
- It won't offer to post if the PR's head isn't the commit it reviewed (unpushed local commits, or new pushes during the review), because the comments would land on the wrong lines.

## The team

The cast team is saved outside the reviewed repo, so a review never touches its working tree:

```
${LENS_REVIEW_HOME:-~/.claude/lens-review}/teams/<repo-slug>/*.md
```

`<repo-slug>` comes from the `origin` remote (`git@github.com:acme/web.git` becomes `acme-web`). A repo with no remote gets its directory name plus a short path hash.

Each persona is one Markdown file. Edit a file to change a persona, or add a file to add one. The next run picks up your changes, and validates every file first, so a malformed persona stops the run instead of being skipped:

```markdown
# The Payments Reviewer

Scope:
- **/payments/**
- **/billing/**

Signals:
- \bchargeCard\(
- from ['"]@acme/payments['"]

Rules:
- [must] Every amount is an integer number of minor units, never a float.
- [should] A retried charge is idempotent.
- Do not flag UI copy.
```

- `# Name`: the persona's display name.
- `Scope:`: glob patterns for **where** the persona's code lives. A persona whose scope is `**` reviews every PR (core). Any other persona joins the panel when a changed file matches its Scope.
- `Signals:` (optional): regexes for **what** the persona's concern looks like. Each is tested against every line the PR adds or removes, in any file, and a match also brings the persona onto the panel. That's how the Payments Reviewer above joins a PR that calls `chargeCard(` from a checkout page outside `payments/`. Signals are case-sensitive JavaScript regexes, at most 200 characters, and may not match an empty line. Keep them specific: a signal that matches ordinary code puts its persona, and its cost, on every PR. Casting writes them from the repo's real names (its design-system package, its ORM calls). A persona needs a Scope, Signals, or both. Files written before Signals existed keep working unchanged.
- `Rules:`: each one starts with `[must]`, `[should]` or `[suggestion]`. A rule with no tag counts as `[should]`, and a long rule can wrap onto indented lines.

The base personas the casting step starts from are in [`skills/lens-review/team/`](skills/lens-review/team/). The generic review checklist is [`skills/lens-review/checklist.md`](skills/lens-review/checklist.md).

## Cost and models

Every reviewer runs on **Haiku 5.5**, except one deep-pass reviewer on **Sonnet 5.5**. Casting (once per repo) and the skeptic run on **Opus 5.5**.

| Agent | Count | Model |
|---|---|---|
| Casting | 1, first run per repo only (~$0.50–0.80) | Opus 5.5 |
| Anthropic-general | 1 | Haiku 5.5 |
| Deep pass | 1 (~$0.20–0.40) | Sonnet 5.5 |
| Persona reviewers | 5 core + 0–4 area + 0–2 project (at most 11) | Haiku 5.5 |
| Skeptic | 1 (~$0.30–0.50) | Opus 5.5 |

A run uses at most 14 agents, or 15 on a repo's first run. Measured on two real PRs, a run costs **~$1.70–2.20**: ~$0.65–0.95 for the spawned agents and ~$1.30–1.75 for the orchestrating session, plus casting on a repo's first run. It takes 3–4.5 minutes. Each run prints its cost and timing telemetry after the report. If the spawned agents go over **$1.50 or 1M tokens**, something grew too large, usually a huge diff or a team with too many scoped personas. Narrow the scopes or split the PR. The `## Cost` section of [`SKILL.md`](skills/lens-review/SKILL.md) has the details.

## Tests

```bash
npm test
```

This runs the unit tests for every script, the skill-layout checks and the seeded-PR fixture checks. It uses no dependencies and makes no network calls.

An opt-in live eval runs the real skill through `claude -p` against a seeded PR (`tests/lens-review-eval/seeded-pr/`). It casts a fresh team in a temporary `LENS_REVIEW_HOME`, so your saved teams are never touched. Then it scores the findings against `expected.json`: every seeded issue must be caught and the seeded non-issue dropped. It spends a real review plus a first-run casting, so it is skipped unless you ask for it:

```bash
RUN_LIVE_EVAL=1 npm test
```

### Benchmark (ReviewBench)

lens-review can also be scored on [ReviewBench](https://github.com/review-bench/ReviewBench), an open benchmark of 219 real PRs with reference findings and an LLM judge. `tests/lens-review-eval/reviewbench/` holds a container adapter for ReviewBench's agent contract: a Dockerfile, and an entrypoint that runs lens-review headless on each PR and writes its findings in the judge's format. ReviewBench's own `scripts/try-agent.sh` runs the image and its judge scores the results. Reviews run on a Claude subscription token from `claude setup-token`, and every PR is capped by `RB_CONFIG_MAX_BUDGET_USD`. `npm test` checks the adapter with a fake `claude` and spends nothing. The live steps (a 3-PR pilot first) are in [`tech-design.md`](tests/lens-review-eval/reviewbench/tech-design.md#live-runs-after-merge-by-the-developer-only).

## License

[MIT](LICENSE)
