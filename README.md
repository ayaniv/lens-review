<p align="center">
  <img src="assets/logo-light.png#gh-light-mode-only" alt="Lens Review" width="300">
  <img src="assets/logo-dark.png#gh-dark-mode-only" alt="Lens Review" width="300">
</p>

# lens-review

A [Claude Code](https://claude.com/claude-code) skill that reviews a branch or PR with a synthetic team of reviewer personas, so it needs no PR-comment history. The first time you run it in a repo, it casts a team from the repo's layout and its own AGENTS.md / CLAUDE.md / Cursor / Copilot rules, and saves that team for later runs. On each review it picks the panel from what the PR changes. Five core personas (Architect, Maintainer, Reliability Engineer, Domain Expert, Reuse Scout) review every PR. The backend, design-system, data and infra personas join only when the PR touches their concern: a changed file is in their area, or a changed line anywhere looks like their concern (for example, an app overriding a design-system component's style). The personas then challenge each other's findings, and an Opus skeptic decides which findings make the final report.

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
/lens-review --recast                          # throw away the saved team and cast a fresh one
```

The base defaults to the remote's default branch, then a local `main`, then `master`.

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

Every reviewer, persona and challenge turn runs on **Haiku 5.5**. Only two steps run on **Opus 5.5**: casting (once per repo) and the skeptic. No other model is used.

| Agent | Count | Model |
|---|---|---|
| Casting | 1, first run per repo only (~$0.50–0.80) | Opus 5.5 |
| Anthropic-general, Generic-PR | 2 | Haiku 5.5 |
| Persona reviewers | 5 core + 0–4 area + 0–2 project (at most 11) | Haiku 5.5 |
| Team challenge | +1 turn per persona agent | Haiku 5.5 |
| Skeptic | 1 (~$0.30–0.50) | Opus 5.5 |

A run uses at most 14 agents, or 15 on a repo's first run. Expect **~$0.50–1 per run** for the spawned agents, plus ~$0.20–0.50 for the orchestrating session, plus casting on a repo's first run. Each run prints its cost telemetry after the report. If a run goes over **$2 or 1M tokens**, something grew too large, usually a huge diff or a team with too many scoped personas. Narrow the scopes or split the PR. The `## Cost` section of [`SKILL.md`](skills/lens-review/SKILL.md) has the details.

## Tests

```bash
npm test
```

This runs the unit tests for every script, the skill-layout checks and the seeded-PR fixture checks. It uses no dependencies and makes no network calls.

An opt-in live eval runs the real skill through `claude -p` against a seeded PR (`tests/lens-review-eval/seeded-pr/`). It casts a fresh team in a temporary `LENS_REVIEW_HOME`, so your saved teams are never touched. Then it scores the findings against `expected.json`: every seeded issue must be caught and the seeded non-issue dropped. It spends a real review plus a first-run casting, so it is skipped unless you ask for it:

```bash
RUN_LIVE_EVAL=1 npm test
```

## License

[MIT](LICENSE)
