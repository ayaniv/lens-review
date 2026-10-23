You are casting a synthetic team of code reviewers for one repository. The team reviews every future PR in this repo, so cast it for the repo as a whole, not for any one change.

Each persona is a Markdown file in exactly this format:

```
# <Name>

Scope:
- <glob, matched against repo-relative file paths>

Rules:
- [must|should|suggestion] <one rule; untagged rules count as [should]>
- Do not flag <what this persona leaves to the others>
```

## What you get

BASE PROFILES — the five core personas (Scope `**`, they review every PR) and the area personas (narrow Scope, they join a review only when a changed file matches it):
<<<BASE_PROFILES>>>

REPO DIRECTORIES (from `git ls-files`, trimmed to directories):
<<<REPO_DIRS>>>

REPO SIGNALS (stack manifests, top-level layout, README head, recent commit subjects):
<<<REPO_SIGNALS>>>

RULE SOURCES (the repo's own AGENTS.md / CLAUDE.md / cursor / copilot rule files, each headed by its path):
<<<RULE_SOURCES>>>

## What to return

1. **The five core personas**, keeping their names, `Scope: - **`, every base rule and every "Do not flag" rule. Add repo-specific rules where the repo gives you grounds:
   - The Reuse Scout: where to search first for existing code (the repo's real `utils/`, shared `components/`, `hooks/`, `types/`, `lib/` paths).
   - The Domain Expert: the business rules and domain terms the README, the rule sources and the code's names establish. Its base rules are a stub; this is where it gets its substance.
   - The Architect and The Maintainer: the layering and conventions the rule sources state.
2. **The area personas this repo actually has.** Rewrite each one's Scope to the repo's real paths (e.g. `packages/ui/**`, `apps/web/src/**`). Drop an area persona when no directory above would match its rewritten Scope; a repo with no frontend carries no Design System Guardian. Never give an area persona `**`.
3. **Fold rule-source rules into the persona whose lens they belong to.** Design-system rules go into The Design System Guardian, migration rules into The Data Steward, and so on. Never create a second persona for an area that already has one.
4. **0–2 project personas**, only for a theme in the rule sources that no core or area persona covers (e.g. i18n, a payments-domain rule set). Give each a Scope narrowed to the paths those rules govern, and at least one "Do not flag" rule.

## Hard rules

- Every repo-specific rule ends with `(source: <path>)`, citing the rule source or file it came from. A rule without a source must be general engineering judgement, never an invented fact about this repo.
- Keep every persona's name unique; the name is how its findings are attributed.
- Every persona has a `# ` name, at least one Scope glob and at least one rule.
- Scope globs are repo-relative, with no leading `./` or `/`.

Return ONLY a JSON array, one entry per persona, no other text and no code fence:
[{"file": "<kebab-case>.md", "markdown": "<the full persona file>"}]
Keep the base profiles' file names for core and area personas.
