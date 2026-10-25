# lens-review: deeper reviews from the ReviewBench pilot

## Summary
The ReviewBench pilot found 5 of lens-review's 13 misses, 2 of them high severity, needed code outside the diff, 3 were bundled or anchored at the wrong line, and 1 needed the PR description. This plan has every reviewer open the real definitions and callers the diff touches and file one issue per finding at the defect. It adds a deterministic precheck for test plugins and imports no manifest declares, and an optional `--context <file>` that carries the PR description to the reviewers and the skeptic, fed from `pr.json` by the ReviewBench adapter. It ships as one flat task, measured by a developer re-run of the 3-PR pilot.

**QA Spec:** `tests/lens-review-review-depth.test.mjs` and `tests/lens-review-reviewbench.test.mjs`

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
- None depends on the merge fix (`lens-review-merge-keeps-distinct-findings`). This plan doesn't touch `merge-findings.mjs`, or `tests/lens-review-scripts.test.mjs`, which the merge fix edits.

**Improvement 4 (less noise on small PRs) is dropped from this plan.**
- **Why it can't be measured:** the only levers that reduce the count are a cap, ranking or a stricter skeptic, and those cut low-severity findings. Low-severity findings are 7 of the 12 golden TPs the pilot caught, and the judge counts all of them as real. So the change would lower the measured score and couldn't show any gain.
- **Where PR 0's noise comes from:** 3 of its 15 findings are near-duplicate pairs (`handlers.test.ts:44/48`, `customRulesEngine.test.ts:442/455`, `handlers.ts:441/446`). That's a merge or dedup question.
- **Follow-up:** log it as a backlog item, judged by a human read of PR 0's report (a count of findings a reviewer would act on), not by the benchmark.

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
- **Finding shape:** one finding per file, at the first offending added line, naming every undeclared package. Severity `must` (the tests can't run on a clean install), category `reliability`.

### 3. Optional `--context <file>` (PR description as input)
- **`scripts/gather-diff.sh --context <file>`:** copies the file to `<RUN_DIR>/context.txt`. An unreadable file fails with a `lens-review:` message. Without the flag there's no `context.txt`, as before.
- **`scripts/render-prompts.mjs`:** one `readPrContext(runDir)` returns `context.txt` (when present) followed by `pr-context.txt`. It feeds every reviewer prompt and the skeptic.
- **`SKILL.md`:**
  - **Usage:** add `--context <path>` to the frontmatter description, the Arguments paragraph and the top-of-file usage. It's the PR's description or any intent text, and it's the one other file outside the repo that may be read.
  - **Step 1:** pass `--context` to `gather-diff.sh` in both the PR-URL mode and local mode.
- **`tests/lens-review-eval/reviewbench/agent.mjs`:**
  - **When `RB_PR_JSON` is set:** read it, write `title\n\nbody` to `<dirname(RB_OUT)>/pr-context.md`, and run `-p "/lens-review --base <base> --context <that file>"`.
  - **When it's unset:** the prompt is unchanged (backward compatible).
  - **When it's set but unreadable, not JSON, or has no title:** fail with a `lens-review:` message before claude starts.

## QA spec (written now, failing until dev implements)
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

`tests/lens-review-reviewbench.test.mjs` gets a new `@pending` describe inside the agent describe, which reuses its fake `claude`:
- `RB_PR_JSON` gives `--context`, and the file holds the title and body;
- with no `RB_PR_JSON`, the prompt is unchanged;
- a malformed `pr.json` is refused before claude starts.

**State at planning:** 14 of the new cases fail, each because its feature is missing: no shared rules file, `--context` unknown, no `undeclared-dependency` check, no `RB_PR_JSON` handling. The quiet-path cases already pass, and they guard against false positives. Dev runs both files first to confirm that, implements with red-green TDD, and drops the `@pending` tags once its cases pass. Until then, `npm test` on this branch is red by design.

**Also for dev:** the existing "prechecks on the real-PR answer keys" counts must stay exact. The new check must not fire on `lens-review-pr3` or `carpool-pr13`.

## Verify
- **Verifier:** `npm test` (`node --test tests/*.test.mjs`). It's confirmed in `package.json`.
- **Developer-run, after merge (never by an agent):** re-run the 3-PR pilot with `/Users/yanivaharon/Dev/cockpit-ai/tasks/lens-review-reviewbench-pilot/run-pilot.sh`. It costs about $4 of Max usage plus under $1 of judge.
- **Expected outcome:**
  - PR 4's missing pytest-mock/pytest-asyncio issue is caught by the precheck, deterministically.
  - PR 4's mock signature and return-type issues are caught.
  - PR 9's call-order issue (the freshness check after `MinimizeCopilotComments`) is caught.
  - High-severity recall reaches at least 3 of 5.
  - Grounded precision stays at or above about 0.7.
  - Mean review cost stays at or below about $1.6 per PR (the pilot's was $1.24). The extra reads are capped.

## Files
- **Prompts:** `skills/lens-review/reviewer-shared-rules.md` (new), `reviewer-{general,deep-pass,persona}-prompt.md`, `skeptic-prompt.md`
- **Scripts:** `scripts/render-prompts.mjs`, `scripts/gather-diff.sh`, `scripts/precheck.mjs`, `scripts/prechecks/undeclared-dependency.mjs` (new)
- **Skill:** `SKILL.md`
- **Adapter:** `tests/lens-review-eval/reviewbench/agent.mjs`
- **Tests:** `tests/lens-review-review-depth.test.mjs` (new), `tests/lens-review-reviewbench.test.mjs`

