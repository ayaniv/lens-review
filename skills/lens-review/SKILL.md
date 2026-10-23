---
name: lens-review
description: Pre-PR review by a synthetic team of reviewer personas — no PR-comment history needed. Casts a team per repo from its layout and its own AGENTS.md/CLAUDE.md/cursor/copilot rules, picks the panel from what the PR changes (core personas always; backend, design-system, data and infra personas only when their files change), lets the personas challenge each other's findings, and has an Opus skeptic rule on what survives. When the review is of an open GitHub PR, offers to post it there as inline comments. Usage — /lens-review [--base <ref>] [<GitHub PR URL>] [--recast].
allowed-tools: ["Agent", "SendMessage", "ToolSearch", "Bash", "Glob", "Grep", "Read", "Write"]
---

# Lens Review — a synthetic review team

You are the orchestrator for a multi-persona PR review. Follow every step below, in order.

Each persona is a lens on the PR. Five **core** personas (The Architect, The Maintainer, The Reliability Engineer, The Domain Expert, The Reuse Scout) review every PR. **Area** personas (The Backend Reviewer, The Design System Guardian, The Data Steward, The Infra Reviewer) and up to two **project** personas join only when a changed file matches their `Scope` or a changed line, in any file, matches one of their `Signals`: Scope says where a persona's code lives, Signals say what touching its concern looks like, so a lens follows its concern across the repo's layout. The team is cast once per repo and saved outside it, so the developer can hand-edit or add personas and the next run picks them up.

**Paths.** You run with the cwd set to the repo under review. `SKILL_DIR` below means this skill's base directory, the one Claude Code printed when the skill loaded; always call scripts as `node "<SKILL_DIR>/scripts/<file>"` with that absolute path substituted, never a cwd-relative path. Shell variables don't survive between Bash calls, so substitute the run dir and team dir literally too.

**Arguments.** `--base <ref>` (default: the remote's default branch, else a local `main`, else `master`), an optional GitHub PR URL, and `--recast` (cast a fresh team even if one is saved).

**Failure rule.** Every script exits non-zero with a `lens-review:` message naming the bad input. When one does, stop and show that message; never continue past a failed step.

**Agent replies.** Never judge for yourself whether an agent's reply is JSON, and never fix one up. `Write` the reply verbatim to `<RUN_DIR>/reply-<name>.txt`, then run `node "<SKILL_DIR>/scripts/parse-reply.mjs" "<RUN_DIR>/reply-<name>.txt" "<RUN_DIR>/<output>.json"`. It strips one code fence wrapped around the whole reply and nothing else. When it exits non-zero, it has written nothing: that agent failed, as each step below says, and the failure rule does not apply.

---

## Step 1 — Gather the diff

- **PR URL given:** `gh pr view <url> --json title,body,headRefOid` for the title, description and head commit, then `gh pr diff <url> > <a temp file>` and run `bash "<SKILL_DIR>/scripts/gather-diff.sh" --diff <that file>`. `Write` the `headRefOid` to `<RUN_DIR>/head.txt`.
- **Otherwise:** `bash "<SKILL_DIR>/scripts/gather-diff.sh"`, adding `--base <ref>` only when one was passed. Use `git log --format='%s%n%b' <base>..HEAD` as the PR context, and run `git rev-parse HEAD > "<RUN_DIR>/head.txt"`.

`scripts/gather-diff.sh` prints a fresh per-run dir as its last line: `RUN_DIR`. It holds `diff.patch`, `files.txt` (the changed files) and `base.txt` (the commit the PR branched from, which casting reads). `head.txt` (written just after) is the commit under review; Step 6 only posts onto a PR whose head is that same commit. Every later file this run writes goes in `RUN_DIR`, so concurrent reviews never clobber each other.

Find the rule files that govern the changed files:
```bash
node "<SKILL_DIR>/scripts/discover-rule-sources.mjs" --repo . --files "<RUN_DIR>/files.txt"
```
`scripts/discover-rule-sources.mjs` returns `[{path, kind}]`, nearest AGENTS.md / CLAUDE.md first, then the repo-wide cursor and copilot rules. Read them; they override generic rules.

---

## Step 1b — Cast or load the team, then pick the panel

```bash
node "<SKILL_DIR>/scripts/team-dir.mjs" --repo .
```
`scripts/team-dir.mjs` prints `TEAM_DIR` (under `${LENS_REVIEW_HOME:-~/.claude/lens-review}/teams/`) and creates it.

**Load** — when `TEAM_DIR` holds `*.md` files and `--recast` wasn't passed:
```bash
node "<SKILL_DIR>/scripts/validate-team.mjs" "<TEAM_DIR>"
```
`scripts/validate-team.mjs` passes → the team is loaded (`team: loaded`). If it fails, stop and show which persona file is malformed and why. Never review with part of the team; a dropped persona is a silently skipped lens.

**Cast** — on the first run in a repo, or with `--recast` (then first delete the `*.md` files in `TEAM_DIR`). The team is saved for every future PR, so cast from the code this PR branched from, never the PR's own code: a helper the PR adds would otherwise be saved as existing code to reuse. Check out the base commit:
```bash
git worktree add --detach "<RUN_DIR>/base" "$(cat "<RUN_DIR>/base.txt")"
```
Build every casting input from `<RUN_DIR>/base`. When casting ends, saved or failed, run `git worktree remove --force "<RUN_DIR>/base"`.
1. Build the casting inputs:
   - `<<<BASE_PROFILES>>>`: every file in `<SKILL_DIR>/team/`, each headed by its file name.
   - `<<<REPO_DIRS>>>`: `git -C "<RUN_DIR>/base" ls-files | xargs -n1 dirname | sort -u` (cap at ~400 lines).
   - `<<<REPO_SIGNALS>>>`: the stack manifests at the root of `<RUN_DIR>/base` (`package.json`, `pyproject.toml`, `go.mod`, `Gemfile`, `Cargo.toml`, …, whichever exist), `ls` of that root, the first ~60 lines of its README, and `git -C "<RUN_DIR>/base" log -30 --format=%s`.
   - `<<<RULE_SOURCES>>>`: `git -C "<RUN_DIR>/base" ls-files > "<RUN_DIR>/all-files.txt"`, then `node "<SKILL_DIR>/scripts/discover-rule-sources.mjs" --repo "<RUN_DIR>/base" --files "<RUN_DIR>/all-files.txt"`, and the text of each file it lists under `<RUN_DIR>/base`, headed by its path. Cap at ~15k tokens, dropping the most deeply nested files first (ties: last in path order). The cast team is saved for every future PR, so the cut must not depend on which PR triggered it.
2. Spawn ONE agent with `model: "opus"` and the prompt from `<SKILL_DIR>/casting-prompt.md` with those placeholders filled. Casting is the one step where judgement about the whole repo matters, and it runs once per repo.
3. It returns `[{file, markdown}]`. Parse it with `node "<SKILL_DIR>/scripts/parse-reply.mjs" "<RUN_DIR>/reply-cast.txt" "<RUN_DIR>/cast.json"` (a reply that isn't JSON is a failed cast, handled like a failed validation in 4), then save it with `node "<SKILL_DIR>/scripts/save-cast.mjs" "<TEAM_DIR>" "<RUN_DIR>/cast.json"`. Never `Write` persona files yourself: casting reads the reviewed repo's own rule files, so its output is untrusted, and `scripts/save-cast.mjs` refuses any file name that isn't a bare kebab-case `.md` name, or any persona that doesn't parse, before writing anything. Then run `scripts/validate-team.mjs` on `TEAM_DIR` (`team: cast`).
4. If saving or validation fails, show the errors, delete any written files and cast once more, adding the validation errors to the prompt. If the second cast fails too, **stop** with the errors.

**Pick the panel:**
```bash
node "<SKILL_DIR>/scripts/select-team.mjs" "<TEAM_DIR>" "<RUN_DIR>/files.txt" "<RUN_DIR>/diff.patch"
```
`scripts/select-team.mjs` returns `{panel, selected: [{file, name, matchedBy}], uncoveredFiles}`. `selected` is the panel for this PR: every core persona plus each scoped persona that a changed file's path matched (Scope) or one of its added or removed lines matched (Signals); `matchedBy` lists those files. Keep `panel` (the `Panel: …` line) and `uncoveredFiles` for the report header.

---

## Step 2 — Spawn the reviewers in parallel (all Haiku 5.5)

In a **single message**, spawn every agent below with `model: "haiku"`. Each reads the diff from `<RUN_DIR>/diff.patch` instead of getting it inline. That's 2 generic reviewers plus one agent per selected persona.

Every prompt's `<<<CATEGORIES>>>` is this list, verbatim: `security, correctness, reliability, performance, architecture, maintainability, duplication, design-system, data, infra, domain, tests`. One shared vocabulary is what lets the merge step recognise two reviewers' findings as the same issue.

### A. Anthropic-general reviewer

```
You are a senior Anthropic engineer doing a general code review — universal software engineering quality, not team-specific conventions.

The diff is at <RUN_DIR>/diff.patch. Read it.

PR context:
<<<PR_TITLE_AND_DESCRIPTION>>>

Focus ONLY on:
- Logic bugs, off-by-one errors, wrong conditionals
- Race conditions and async correctness (missing awaits, stale closures)
- Security vulnerabilities (XSS, injection, sensitive data exposure)
- Memory leaks (missing cleanup, unrevoked ObjectURLs, stale subscriptions)
- TypeScript type unsafety that strict mode doesn't catch
- Missing error handling at system boundaries
- Test gaps for new behavior that is entirely untested

Do NOT flag naming, formatting, styling, or anything team/company-specific.

Return ONLY a JSON array, no other text and no code fence. Each finding: {file, line, severity (must|should|suggestion), category (one of: <<<CATEGORIES>>>), description, rule, reviewer: "Anthropic"}. Return [] if no issues.
```

### B. Generic-PR reviewer

```
You are a senior engineer doing a thorough code review of a PR.

The diff is at <RUN_DIR>/diff.patch. Read it.

PR context:
<<<PR_TITLE_AND_DESCRIPTION>>>

Review for:
- Correctness: logic errors, edge cases, off-by-ones, wrong assumptions
- Code quality: clarity, unnecessary complexity, dead code, naming
- Performance: unnecessary re-renders, expensive operations in hot paths, queries in loops
- Test coverage: is new behavior tested? are edge cases / error paths covered?
- Security: XSS, injection, sensitive data exposure

Return ONLY a JSON array, no other text and no code fence. Each finding: {file, line, severity (must|should|suggestion), category (one of: <<<CATEGORIES>>>), description, rule, reviewer: "Generic"}. Return [] if no issues.
```

### C. One persona agent per selected persona

For each persona in `selected`, spawn one agent with this prompt. For The Maintainer, append the text of `<SKILL_DIR>/checklist.md` as its checklist. For The Reuse Scout, the agent also needs Grep and Glob, and its rules cap its searches.

```
You are <<<PERSONA_NAME>>>, one reviewer on a team. Review this PR only through your own lens, defined by your persona file below. Your "Do not flag" rules are as binding as the others: the rest of the team covers what they leave out.

PERSONA FILE:
<<<PERSONA_FILE>>>

The diff is at <RUN_DIR>/diff.patch. Read only the hunks for files that match your Scope or your Signals<<<SCOPE_NOTE>>>.

PR context:
<<<PR_TITLE_AND_DESCRIPTION>>>

REPO RULE FILES (they override generic rules when they conflict):
<<<RULE_SOURCE_PATHS>>>

INSTRUCTIONS:
- Only flag issues clearly present in the diff; cite the file path exactly as the diff shows it (repo-relative, never absolute) and the exact line number on the new side of the diff.
- A rule's [must]/[should]/[suggestion] tag is the finding's severity; untagged rules are [should].
- Skip anything a linter or the type checker already enforces.
- When a finding comes from a rule that cites `(source: <path>)`, say so in `rule`.

Return ONLY a JSON array, no other text and no code fence. Each finding: {file, line, severity (must|should|suggestion), category (one of: <<<CATEGORIES>>>), description, rule, reviewer: "<<<PERSONA_NAME>>>"}. The Reuse Scout adds "duplicates": "<path>:<line>" pointing at the existing code. Return [] if no issues.
```
`<<<SCOPE_NOTE>>>` is empty for a core persona (it reads the whole diff) and ` (these: <matchedBy>)` for a scoped one.

**Collect.** For each agent, `node "<SKILL_DIR>/scripts/parse-reply.mjs" "<RUN_DIR>/reply-<agent>.txt" "<RUN_DIR>/findings-<agent>.json"`. When it exits non-zero, that agent is a **failed reviewer**: list it in the telemetry and go on with the rest. Then:
```bash
node "<SKILL_DIR>/scripts/merge-findings.mjs" --diff "<RUN_DIR>/diff.patch" "<RUN_DIR>"/findings-*.json > "<RUN_DIR>/merged.json"
```
`scripts/merge-findings.mjs` merges the same issue flagged by several reviewers into one finding (highest severity, every reviewer in `reviewers`), gives each an `F<n>` id, and reports malformed findings on stderr — including any whose file isn't in the diff or whose line falls outside its changed hunks. Carry its "dropped N malformed findings" line into the telemetry. Never re-derive or restate its dedup rule here; the script is the one place it lives.

---

## Step 3 — Team challenge round

**Skip only when `merged.json` is `[]`**; then print `Challenge round: skipped (0 findings)` in the telemetry. Otherwise the round always runs; it is the team's chance to push back on each other.

Fill `<SKILL_DIR>/challenge-prompt.md`'s `<<<MERGED_FINDINGS>>>` with `merged.json`.

- **Continued (preferred):** load `SendMessage` with `ToolSearch` (`select:SendMessage`), then send the filled prompt to each persona agent from Step 2C. Each still holds the diff in context, so the turn is mostly cache reads.
- **Fresh (fallback):** if `SendMessage` can't be loaded or a continuation fails, spawn one fresh `model: "haiku"` agent per persona with its persona file, the path to `<RUN_DIR>/diff.patch` (the hunks in its Scope), and the filled prompt. Don't let the round silently disappear.

For each reply, `node "<SKILL_DIR>/scripts/parse-reply.mjs" "<RUN_DIR>/reply-votes-<persona-file-stem>.txt" "<RUN_DIR>/votes-<persona-file-stem>.json"` (a non-zero exit counts as a failed voter in the telemetry), then:
```bash
node "<SKILL_DIR>/scripts/tally-challenges.mjs" "<RUN_DIR>/merged.json" "<RUN_DIR>"/votes-*.json > "<RUN_DIR>/tallied.json"
```
`scripts/tally-challenges.mjs` attaches each finding's `challenge: {agree, dispute}`, marks it `contested` when disputes outnumber agreements, and reports dropped votes (unknown ids, unknown verdicts, self-votes) on stderr. Record `Challenge round: <n> personas voted (continued|fresh), <k> contested`.

---

## Step 4 — Skeptic pass (Opus, single agent)

Spawn ONE agent with `model: "opus"`:

```
You are a skeptical senior engineer. Below are code review findings from a team of reviewers, with the team's own votes on each one.

The diff is at <RUN_DIR>/diff.patch. Read it.

For each finding, check:
1. Does the cited file + line actually contain the issue described? (catch hallucinated line numbers)
2. Is there enough diff context to confirm the rule was violated, or is it just a guess?
3. Is the finding a false positive from a reviewer applying their lens too broadly?

You MUST rule explicitly on every finding with "contested": true. The team's disputes are evidence, not a veto: keep a contested finding when the diff proves it, drop it when the dispute holds.

Never drop a finding because another finding repeats it. Merging repeats was done before you, and two findings that look alike can carry different evidence (a pointer to the existing code, a different reviewer's lens). Rule on each one by the three checks above alone.

FINDINGS:
<<<TALLIED_FINDINGS_JSON>>>

Return ONLY a JSON array with one entry per finding id, no other text and no code fence:
[{"id": "F<n>", "verdict": "keep" | "drop", "reason": "<one sentence>"}]
```

Parse its reply with `node "<SKILL_DIR>/scripts/parse-reply.mjs" "<RUN_DIR>/reply-skeptic.txt" "<RUN_DIR>/skeptic.json"`. If the skeptic fails, the parse exits non-zero, or `skeptic.json` leaves **any** finding id from `tallied.json` without a verdict, **stop** and say which ids it skipped. A finding the skeptic never ruled on would otherwise vanish from the report without a trace. Never print the unfiltered findings as the final review.

Build `<RUN_DIR>/final-findings.json` with `Write`: every finding from `tallied.json` whose verdict is `keep`, unchanged (`id`, `file`, `line`, `severity`, `category`, `description`, `rule`, `reviewers`, `duplicates`, `locations`, `challenge`, `contested`), plus `"skeptic": {"verdict", "reason"}`.

---

## Step 5 — Report

Print the report. The `Panel:`, `Challenge round:` and `Findings JSON:` lines start at the beginning of their line, exactly as shown; the eval reads them.

```
## Lens Review: <branch-name>

Team: <persona names, comma-separated> (team: loaded | team: cast)
<panel line from select-team.mjs, e.g. Panel: core ×5 + The Backend Reviewer (api/orders.ts)>
Uncovered by any scoped persona: <uncoveredFiles, or "none">

**Summary:** <1-2 sentences: what this PR does and what it touches>

---

### Must Fix (<N>)
Bugs, architectural violations, or things a reviewer would block on.
- [Category] Description — `path/to/file.ts:42`

### Should Fix (<N>)
Worth addressing before merge, not hard blockers.
- [Category] Description — `path/to/file.ts:42`

### Suggestions (<N>)
Minor polish — low effort, nice to have.
- [Category] Description — `path/to/file.ts:42`

### Strengths
1–3 specific things done well.

---

### Pre-Merge Checklist
- [ ] Type check / build passes
- [ ] Tests pass for affected paths
- [ ] PR description written
- [ ] No debug artifacts left in

---

**Verdict: APPROVED** / **CHANGES REQUIRED**
_(APPROVED = ready to send. CHANGES REQUIRED = address Must Fix items first.)_

Findings JSON: <RUN_DIR>/final-findings.json
```

A duplication finding also names the existing code: `— \`src/format.ts:4\` (duplicates \`src/utils/money.ts:2\`)`. A finding with `locations` stands for every copy it lists: name each one, `— \`e2e/a.spec.ts:21\`, \`e2e/b.spec.ts:16\` (duplicates \`e2e/helpers.ts:27\`)`. Drop the per-finding reviewer names from the public findings list (they confuse PR authors); they stay in `final-findings.json`. Omit any findings section that is empty.

### Cost telemetry (always print after the report)

Use the `usage` block from each Agent result, and the prices in `## Cost`.

```
Cost breakdown (spawned agents only; this orchestrating session's own turns are excluded):
  Casting           (Opus):    ~Xk tokens   ~$0.XX   | or "skipped (team: loaded)"
  Anthropic-general (Haiku):   ~Xk tokens   ~$0.XX
  Generic-PR        (Haiku):   ~Xk tokens   ~$0.XX
  <Persona>         (Haiku):   ~Xk tokens   ~$0.XX   (one line per persona)
  Challenge round   (Haiku):   ~Xk tokens   ~$0.XX
  Skeptic           (Opus):    ~Xk tokens   ~$0.XX
  Total subagent:              ~Xk tokens   ~$X.XX
Challenge round: <n> personas voted (continued|fresh), <k> contested   | or: Challenge round: skipped (0 findings)
Failed reviewers: <names, or none>
Dropped: <N> malformed findings, <M> votes
```

---

## Step 6 — Offer to post the review to the PR

Run this after the report whenever the review is of a GitHub PR. Posting writes publicly to someone's PR, so it never happens without the developer's yes.

1. Find the PR. With a PR URL, that's the PR. Otherwise run `gh pr view --json url,headRefOid` for the current branch. If that fails, print `Not offered for posting: <first line of gh's error>` (no open PR, or `gh` missing or signed out) and end the run. That is not a failure.
2. Run `gh pr view <url> --json headRefOid --jq .headRefOid`. If it differs from `<RUN_DIR>/head.txt`, do not offer to post: print `Not offered for posting: the PR's head is <sha>, but this review is of <head.txt>`, and say to push or re-run. Comments on a different commit would land on the wrong lines.
3. Take `<OWNER>`, `<REPO>` and `<NUMBER>` from the URL (`https://github.com/<OWNER>/<REPO>/pull/<NUMBER>`). Fetch the PR's own diff with `gh pr diff <url> > "<RUN_DIR>/pr-diff.patch"`, since GitHub accepts inline comments only on lines in that diff. Then `Write` `<RUN_DIR>/pr-summary.md`: the report's `## Lens Review` heading, `**Summary:**` line, Strengths and Verdict. Leave out the findings sections (they become the inline comments), the cost telemetry and the `Findings JSON:` line. Build the review:
   ```bash
   node "<SKILL_DIR>/scripts/build-pr-review.mjs" --findings "<RUN_DIR>/final-findings.json" --diff "<RUN_DIR>/pr-diff.patch" --summary "<RUN_DIR>/pr-summary.md" --commit "$(cat "<RUN_DIR>/head.txt")" > "<RUN_DIR>/pr-review.json"
   ```
   `scripts/build-pr-review.mjs` always builds a plain `COMMENT` review, never an approval or a change request: the verdict is for the humans. Each finding becomes an inline comment on its line; one whose line isn't in the PR's diff goes in the review body under "Not on a changed line".
4. Check for an earlier lens-review review: `gh api "repos/<OWNER>/<REPO>/pulls/<NUMBER>/reviews" --paginate --jq '[.[] | select(.body | contains("<!-- lens-review -->"))] | length'`. When it's above 0, say the PR already has that many; the new review is added next to them.
5. Show what would be posted: the review body, then each inline comment as `<path>:<line>` followed by its body. Ask **"Post this review to <url> as inline comments? (yes/no)"**. On anything but an explicit yes, print `Not posted.` and end the run.
6. Post it:
   ```bash
   gh api --method POST "repos/<OWNER>/<REPO>/pulls/<NUMBER>/reviews" --input "<RUN_DIR>/pr-review.json" --jq .html_url
   ```
   Print the URL it returns. If it fails, show `gh`'s error verbatim and the payload path. Never retry with comments stripped or moved, since that would post a different review from the one the developer approved.

---

## Cost

Every reviewer, persona and challenge turn runs on **Haiku 5.5** ($0.10 in / $0.50 out per million tokens, for prompts up to 100K tokens; $0.50 / $2.50 beyond). Only casting (first run per repo) and the skeptic run on **Opus 5.5** ($4 / $20). No other model is used.

| Agent | Count | Model |
|---|---|---|
| Casting | 1, first run per repo only (~$0.50–0.80) | Opus 5.5 |
| Anthropic-general, Generic-PR | 2 | Haiku 5.5 |
| Persona reviewers | 5 core + 0–4 area + 0–2 project (at most 11) | Haiku 5.5 |
| Team challenge | +1 turn per persona agent (fresh agents if `SendMessage` is unavailable, ~$0.05) | Haiku 5.5 |
| Skeptic | 1 (~$0.30–0.50) | Opus 5.5 |

At most 14 agents per run (15 on a repo's first run). Expect **~$0.50–1 per run for the spawned agents**, plus ~$0.20–0.50 for the orchestrating session, plus casting on a repo's first run. Keep each persona agent under 100K prompt tokens to stay in Haiku's lower price tier: scoped personas read only their own hunks, and the core personas, which read the whole diff, are the ones to watch on a huge PR.

**Alarm:** if a run goes over **$2 or 1M tokens**, something ballooned (a huge diff, or a team with too many scoped personas). Narrow the Scopes in `TEAM_DIR`, or split the PR, before running again.
