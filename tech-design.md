# lens-review: deeper reviews from the ReviewBench pilot

## Summary
The ReviewBench pilot found 5 of lens-review's 13 misses, 2 of them high severity, needed code outside the diff, 3 were bundled or anchored at the wrong line, and 1 needed the PR description. This plan has every reviewer open the real definitions and callers the diff touches and file one issue per finding at the defect. It adds a deterministic precheck for test plugins and imports no manifest declares, and an optional `--context <file>` that carries the PR description to the reviewers and the skeptic, fed from `pr.json` by the ReviewBench adapter. Less noise on small PRs is left to a follow-up, because the benchmark can't measure it. It ships as one flat task with no code dependency on the merge fix. The unit tests prove the wiring, not that reviews get better. That is judged by a developer re-run of the 3-PR pilot after both this task and the merge fix have merged.

## Context
The ReviewBench pilot scored lens-review at grounded recall 0.48 and found that recall drops as severity rises: it caught 2 of the 5 high-severity issues. Of the 13 misses:
- 5 needed code outside the diff:
  - test dependencies `pyproject.toml` never declares;
  - a mock whose signature and return type differ from the real function's;
  - a call order that hides the new check's result;
  - a callback the production code never passes.
- 3 were found, but bundled into a broader finding or anchored at the wrong line.
- 1 needed the PR description.

Reviewers flagged "the mock is never reached" but never opened the real callee. This plan makes the reviewers look past the diff and file one issue per finding, adds a deterministic precheck for undeclared dependencies, and adds an optional `--context <file>` input. The ReviewBench adapter feeds that input from `pr.json`.

## Decision: one flat task, not milestones
- All 3 changes are small: prompt text, one precheck and one optional flag.
- They're measured together by one pilot re-run.
- No milestones, so there's no `needs:` graph to check.

**Relation to the merge fix (`lens-review-merge-keeps-distinct-findings`, PR #9, open):**
- **No code dependency.** This plan doesn't touch `merge-findings.mjs` (`isSameIssue`, `mergeFindings`), or `tests/lens-review-scripts.test.mjs`, which the merge fix edits. Either PR builds, tests green and ships without the other, in either order.
- **There is a measurement dependency.** Today `isSameIssue` folds two *different* reviewers' findings in one file into one, when they share a category and are within 3 lines, and it keeps only the first one's description. So findings this plan splits apart can be folded back together before the skeptic sees them. That applies to the precheck's `undeclared-dependency` finding too, which merges like any reviewer's. One reviewer's own findings never fold into each other.
- **So:** the developer runs the pilot re-run (see Verify) only after **both** PRs have merged. PR 0's path-traversal catch goes to the merge fix, not to this plan.

**Improvement 4 (less noise on small PRs) is dropped from this plan.**
- **Why it can't be measured:** the only levers that reduce the count are a cap, ranking or a stricter skeptic, and those cut low-severity findings. Low-severity findings are 7 of the 12 golden TPs the pilot caught, and the judge counts all of them as real. So the change would lower the measured score and couldn't show any gain.
- **Where PR 0's noise comes from:** 3 near-duplicate pairs among its 15 findings (`handlers.test.ts:44/48`, `customRulesEngine.test.ts:442/455`, `handlers.ts:441/446`). That's a merge or dedup question.
- **This plan pushes the other way, on purpose.** Change 1's "one finding per issue" and the merge fix's "keep distinct findings apart" both raise the finding count. They recover golden TPs (3 bundled misses and 1 erased one), so the trade is worth it. The re-run reports PR 0's finding count so the follow-up has a baseline.
- **Follow-up (not logged yet):** after the re-run, the orchestrator adds a backlog item. It's judged by a human read of PR 0's report (a count of findings a reviewer would act on), not by the benchmark.

## Changes

### 1. Look past the diff, one issue per finding (prompts)
- **One shared source:** add `skills/lens-review/reviewer-shared-rules.md`, filled into every reviewer prompt as `<<<REVIEWER_SHARED_RULES>>>` by `scripts/render-prompts.mjs`. It applies to all three templates: `reviewer-general-prompt.md`, `reviewer-deep-pass-prompt.md` and `reviewer-persona-prompt.md`. The text lives in this one file, not in three copies.
- **Contents:**
  - **Check the code the diff touches.** For each function the diff adds, changes, calls or mocks, open its real definition and its callers with Read or Grep, at most ~10 files. Check four things:
    - a test double's arguments and return shape match the real function's signature;
    - the caller runs the new code in an order that lets its result matter;
    - a new parameter or callback is passed by the production code that constructs the object, not only by tests;
    - a new import, test fixture or plugin marker is declared in the dependency manifest.

    The finding still cites the changed line: the mock, the call or the import.
  - **One finding per issue.** Never fold a specific bug into a broad "weak tests" or "missing coverage" finding.
  - **Anchor each finding at the defect.** An untested branch is anchored at that branch in the code, not at the test file.
- **Persona prompt:** reword "Only flag issues clearly present in the diff" to "issues the diff introduces or exposes", so it doesn't contradict the rule above. Personas still review only their scoped hunks.
- **PR context divergence:** the shared rules also ask for "implementation that diverges from what the PR context promises", so the general reviewer and the personas get it, not only the deep pass.
- **Skeptic:** `skeptic-prompt.md` gets the PR context (`<<<PR_TITLE_AND_DESCRIPTION>>>`), so it can verify a divergence finding instead of dropping it as unproven. There's no keep/drop schema change: the skeptic can't split findings, so improvement 2 is enforced at the reviewers.

### 2. Precheck `undeclared-dependency` (`scripts/prechecks/undeclared-dependency.mjs`)
- Registered in `CHECKS` in `scripts/precheck.mjs`.
- Reuses `precheckFinding` and `isTestFile` from `prechecks/finding.mjs`, and the `repo` API (`files()`, `read()`) from `lib/repo.mjs`.
- **Python:** an added line in a test file that uses a pytest plugin's fixture or marker, where no manifest at head names the plugin. The manifests are `pyproject.toml`, `requirements*.txt`, `setup.cfg`, `setup.py` and `Pipfile`, compared with case and `-`/`_` normalized.
  - The plugin table is data: `mocker` and `pytest_mock` → pytest-mock; `pytest.mark.asyncio` and `pytest_asyncio` → pytest-asyncio; `httpx_mock` → pytest-httpx.
  - General Python imports are **out of scope**: module and distribution names differ (`yaml` is PyYAML), and the stdlib can't be told apart without a list. Either would bring false positives.
- **JS/TS:** an added `import … from 'x'`, `import 'x'`, `require('x')` or `import('x')` with a bare specifier whose package (`@scope/name` or its first segment) no `package.json` in the repo declares. All 4 dependency fields count, and so does a workspace package's `name`.
  - **Skipped:** `node:`/builtins (`module.builtinModules`), relative or absolute paths, `@/`, `~` and `#` aliases, and a first segment that's a top-level directory, or a directory under `src/` (baseUrl aliases).
- **No manifest of that ecosystem at all:** silent.
- **A manifest that doesn't parse:** `package.json` files under fixture paths (`isFixture`) are ignored. Any other `package.json` that isn't valid JSON makes the check throw, naming the file. `runPrechecks` then reports it in `failedChecks` and logs it, and the other checks still run, so the failure is never silent. Python manifests are matched as text, so they can't fail to parse.
- **Finding shape:** one finding per file, at the first offending added line, naming every undeclared package. Severity `must` (the tests can't run on a clean install), category `reliability`.

### 3. Optional `--context <file>` (PR description as input)
- **Optional and backward compatible everywhere:** every caller that passes no `--context` gets the same files and the same prompts as today. Only the skeptic prompt changes, because it now also gets `pr-context.txt`.
- **Why not reuse `--plan`:** a `--plan` doc goes only to The Domain Expert and The Data Steward, the skeptic treats it as an *approved* plan, and the prechecks read its text. A PR description is a claim to check the code against, and every reviewer needs it.
- **`scripts/gather-diff.sh --context <file>`:** copies the file to `<RUN_DIR>/context.txt`. An unreadable file fails with a `lens-review:` message that names it. Without the flag there's no `context.txt`, as before. It combines with `--base` and `--diff`.
- **`scripts/render-prompts.mjs`:** one `readPrContext(runDir)` returns `context.txt` (when present) followed by `pr-context.txt`. It feeds every reviewer prompt and the skeptic.
- **PR-URL mode:** `pr-context.txt` already holds the PR's title and body there. So `--context` in that mode is for intent text beyond the PR body, and passing the body again only repeats it.
- **`SKILL.md`:**
  - **Usage:** add `--context <path>` to the frontmatter description, the Arguments paragraph and the top-of-file usage. It's the PR's description or any intent text, and it's the one other file outside the repo that may be read.
  - **Step 1:** in both the PR-URL mode and local mode, pass `--context <path>` to `gather-diff.sh` only when one was given, the same way `--base` is passed.
- **`tests/lens-review-eval/reviewbench/agent.mjs`:** `RB_PR_JSON=/work/pr/pr.json` is part of ReviewBench's `AGENT_CONTRACT.md` (`{ repo, pr_number, base, head, nwo, title, body }`), so this uses an input the contract already provides.
  - **When `RB_PR_JSON` is set:** read it, write `title\n\nbody` to `<dirname(RB_OUT)>/pr-context.md`, and run `-p "/lens-review --base <base> --context <that file>"`. With a null or empty `body`, the file holds the title alone.
  - **When it's unset:** the prompt is unchanged (backward compatible).
  - **When it's set but unreadable, not JSON, or has no title:** fail with a `lens-review:` message before claude starts.

## QA spec (written now, failing until dev implements)
**QA Spec:** `tests/lens-review-review-depth.test.mjs` and `tests/lens-review-reviewbench.test.mjs`

`tests/lens-review-review-depth.test.mjs` (new, `node --test`, its describe blocks tagged `@pending`) covers these cases:
- **Prompts:**
  - every reviewer prompt holds `reviewer-shared-rules.md`'s text;
  - that text covers callers, mock signature and return shape, call order, production wiring, manifests, one issue per finding and anchoring at the defect;
  - the persona prompt no longer says "clearly present in the diff";
  - the skeptic prompt holds the PR context.
- **`--context`:**
  - `gather-diff.sh --context` writes `context.txt`;
  - a missing file fails, naming the file;
  - no flag writes no `context.txt`;
  - `render-prompts` puts `context.txt` before `pr-context.txt` in the reviewer and skeptic prompts;
  - without it, the prompts are unchanged;
  - `SKILL.md` documents the flag and passes it in both Step 1 modes.
- **Precheck (end to end via `precheck.mjs` on fixture git repos):**
  - a pytest test using `mocker` and `pytest.mark.asyncio` with neither declared gives one `must` finding at the first use, naming both;
  - nothing fires when both are declared, or with no Python manifest;
  - an undeclared JS import is flagged;
  - declared, builtin, `node:`, relative, alias and workspace imports are not.
  - **Dev adds (failure path):** a repo-level `package.json` that isn't JSON puts `undeclared-dependency` in `failedChecks`, with a reason naming the file, while the other checks' findings are still written; a broken `package.json` under a fixture path is ignored.

`tests/lens-review-reviewbench.test.mjs` gets a new `@pending` describe inside the agent describe, which reuses its fake `claude`:
- `RB_PR_JSON` gives `--context`, and the file holds the title and body;
- a null body gives the title alone;
- with no `RB_PR_JSON`, the prompt is unchanged;
- a `pr.json` that isn't JSON, or a missing one, is refused before claude starts, naming the file.

**State at planning (re-run at plan review):** 17 of the new cases fail, each because its feature is missing: no shared rules file, `--context` unknown, no `undeclared-dependency` check, no `RB_PR_JSON` handling. That includes "without a `--context` file the prompts render from `pr-context.txt` alone", which fails only on its skeptic assertion: the skeptic doesn't get the PR context yet. The other quiet-path cases (no manifest, declared or aliased imports, no `RB_PR_JSON`) already pass, and they guard against false positives. Dev runs both files first to confirm that, implements with red-green TDD, and drops the `@pending` tags once its cases pass. Until then, `npm test` on this branch is red by design.

**Also for dev:** the existing "prechecks on the real-PR answer keys" counts must stay exact. The new check must not fire on `lens-review-pr3` or `carpool-pr13`.

## Verify
- **Verifier:** `npm test` (`node --test tests/*.test.mjs`). It's confirmed in `package.json`, and it ran at plan review (red only on the 17 `@pending` cases above).
- **What `npm test` proves:** the precheck's behaviour on fixture repos, `--context` plumbing through `gather-diff.sh`, `render-prompts.mjs`, `SKILL.md` and the adapter, and that every prompt carries the shared rules.
- **What it can't prove:** that a model follows the new prompt text, or that recall goes up. The prompt tests check that text is present, not that reviews change. Only the pilot re-run measures that, and a green `npm test` must not be reported as "reviews are deeper".
- **Developer-run, after this task and the merge fix have both merged (never by an agent):** rebuild the image and re-run the 3-PR pilot with `/Users/yanivaharon/Dev/cockpit-ai/tasks/lens-review-reviewbench-pilot/run-pilot.sh`. It costs about $4 of Max usage plus under $1 of judge.
- **Expected outcome:**
  - PR 4's missing pytest-mock/pytest-asyncio issue is caught by the precheck, deterministically: it's in `precheck.json`. Whether it survives into the final findings depends on the merge and the skeptic, so check both.
  - PR 4's mock signature and return-type issues are caught.
  - PR 9's call-order issue (the freshness check after `MinimizeCopilotComments`) is caught.
  - High-severity recall reaches at least 3 of 5, not counting PR 0's path traversal (that one is the merge fix's).
  - PR 0's finding count is reported (it was 15). It isn't a pass/fail gate, but it's the baseline for the noise follow-up.
  - Grounded precision stays at or above about 0.7.
  - Mean review cost stays at or below about $1.6 per PR (the pilot's was $1.24). The extra reads are capped.

## Files
- **Prompts:** `skills/lens-review/reviewer-shared-rules.md` (new), `reviewer-{general,deep-pass,persona}-prompt.md`, `skeptic-prompt.md`
- **Scripts:** `scripts/render-prompts.mjs`, `scripts/gather-diff.sh`, `scripts/precheck.mjs`, `scripts/prechecks/undeclared-dependency.mjs` (new)
- **Skill:** `SKILL.md`
- **Adapter:** `tests/lens-review-eval/reviewbench/agent.mjs`
- **Tests:** `tests/lens-review-review-depth.test.mjs` (new), `tests/lens-review-reviewbench.test.mjs`

