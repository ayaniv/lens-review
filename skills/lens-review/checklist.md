# Review Checklist

> The Maintainer persona applies this checklist. Edit it freely: add rules, remove outdated ones, adjust severity.
> Format: each rule is a bullet under a category. Mark severity inline: `[must]`, `[should]`, `[suggestion]`.
> Rules without a severity marker default to `[should]`.
>
> Only generic, stack-agnostic rules live here. Repo-specific rules come from the repo's own rule files and land in the cast team's personas.

---

## Correctness
- [must] Code does what the task/ticket requires
- [must] Edge cases handled: empty/null/undefined, loading states, error states
- [must] Async operations are awaited and rejections handled
- [must] No race conditions — stale async results can't overwrite newer ones
- [should] No conditional branches that are logically unreachable or wrong

## React — What Lint Can't Catch
*(Apply only when the diff contains React code. ESLint enforces hooks rules and useEffect deps — focus on semantic correctness)*
- [must] Keys in dynamic lists are stable and unique — array index only valid for static, never-reordered lists
- [should] No prop drilling beyond 2 levels — use context, a store, or composition
- [should] useEffect not used for derived state — prefer useMemo or plain computation in render
- [should] No stale closures where lint passes but the captured value is logically outdated
- [should] Each component has a single clear responsibility

## Code Quality
- [must] No `console.log`, `console.error`, or `debugger` left in
- [must] No `@ts-ignore` or `@ts-expect-error` without an inline comment explaining why TS can't be satisfied properly
- [should] No dead code: unused variables, unreachable branches, commented-out code
- [should] No abstraction added for hypothetical future use (YAGNI)
- [should] No premature memoization — useMemo/useCallback only where there's a real reason
- [should] Prefer simple early returns over nested ternaries or switch cases
- [should] Complex inline expressions broken into named functions — if it's hard to follow, extract it
- [suggestion] Names must clearly communicate intent — misleading names are worse than no names
- [suggestion] Files/components not growing too large — consider splitting if >300 lines
- [suggestion] Non-obvious logic has a brief inline comment explaining *why*, not *what*

## Performance
- [should] No expensive computations running on every render — extract or memoize where measurable
- [should] No unthrottled/undebounced handlers on high-frequency events (scroll, resize, input)
- [should] No large or unnecessary imports added — check for accidental full-library imports vs named imports
- [suggestion] No unnecessary re-renders from new object/array literals or inline functions passed as stable props

## Data and Privacy
- [must] No real people's personal details committed in code, tests, fixtures, seeds, docs or comments: names tied to a relationship, a schedule or availability, contact details. Use placeholders.

## Tests
- [should] New behavior has test coverage
- [must] No existing tests deleted or skipped without justification
- [should] Tests cover the happy path AND at least one edge/failure case
- [suggestion] Test descriptions clearly state what behavior is verified

## PR Hygiene
- [should] Title is clear and imperative — describes the change, not just the ticket number
- [should] Description explains *why* this change is needed, not just what changed
- [should] Scope is focused — no unrelated changes bundled in
- [should] Breaking changes or behavior differences are explicitly called out
- [suggestion] Risky or gradual rollouts sit behind a feature flag
