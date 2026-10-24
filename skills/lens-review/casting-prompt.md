You are casting a synthetic team of code reviewers for one repository. The team reviews every future PR in this repo, so cast it for the repo as a whole, not for any one change.

Each persona is a Markdown file in exactly this format:

```
# <Name>

Scope:
- <glob, matched against repo-relative file paths>

Signals:
- <regex, matched against each line a PR adds or removes, in any file>

Rules:
- [must|should|suggestion] <one rule; untagged rules count as [should]>
- Do not flag <what this persona leaves to the others>
```

## What you get

BASE PROFILES — the five core personas (Scope `**`, they review every PR) and the area personas (they join a review only when a changed file matches their Scope, or a changed line anywhere matches one of their Signals):
<<<BASE_PROFILES>>>

REPO DIRECTORIES (from `git ls-files`, trimmed to directories):
<<<REPO_DIRS>>>

REPO SIGNALS (stack manifests, top-level layout, README head, recent commit subjects):
<<<REPO_SIGNALS>>>

RULE SOURCES (the repo's own AGENTS.md / CLAUDE.md / cursor / copilot rule files, each headed by its path, plus, when the developer opted in, their personal taste file headed `taste`):
<<<RULE_SOURCES>>>

## What to return

1. **The five core personas**, keeping their names, `Scope: - **`, every base rule and every "Do not flag" rule. Add repo-specific rules where the repo gives you grounds:
   - The Reuse Scout: where to search first for existing code (the repo's real `utils/`, shared `components/`, `hooks/`, `types/`, `lib/` paths).
   - The Domain Expert: the business rules and domain terms the README, the rule sources and the code's names establish. Its base rules are a stub; this is where it gets its substance.
   - The Architect and The Maintainer: the layering and conventions the rule sources state.
2. **The area personas this repo actually has.** Rewrite each one's Scope to the repo's real paths (e.g. `packages/ui/**`, `apps/web/src/**`). Drop an area persona when no directory above would match its rewritten Scope; a repo with no frontend carries no Design System Guardian. Never give an area persona `**`.
   Then rewrite its Signals for this repo. Scope says where the persona's code lives; Signals say what touching its concern looks like **anywhere else**, so the persona still joins a PR that crosses into its area from outside it. Use this repo's real names: the import specifier of its design-system package and the names of its components, its ORM's query and migration calls, its auth middleware, its config loader. For example, a Guardian whose Scope is `packages/ui/**` gets `from ['"]@acme/ui['"]` and `<(Button|Card)\b[^>]*\b(style|className)=`. Keep a base signal only when it fits this repo.
3. **Fold rule-source rules into the persona whose lens they belong to.** Design-system rules go into The Design System Guardian, migration rules into The Data Steward, and so on. Never create a second persona for an area that already has one.
   The `taste` file's rules fold the same way (duplication into The Reuse Scout, naming and dead code into The Maintainer, error handling into The Reliability Engineer), each ending `(source: taste)`. Skip any taste rule for a stack this repo doesn't use. When a taste rule and a repo rule conflict, the repo's own rule sources win: drop the taste rule.
4. **0–2 project personas**, only for a theme in the rule sources that no core or area persona covers (e.g. i18n, a payments-domain rule set). Give each a Scope narrowed to the paths those rules govern and/or Signals for the code those rules govern wherever it appears, and at least one "Do not flag" rule.

## Hard rules

- Every repo-specific rule ends with `(source: <path>)`, citing the rule source or file it came from. A rule without a source must be general engineering judgement, never an invented fact about this repo.
- Keep every persona's name unique; the name is how its findings are attributed.
- Every persona has a `# ` name, at least one Scope glob or Signal, and at least one rule. Core personas carry no Signals.
- A signal is a JavaScript regex (case-sensitive, no slashes or flags), tested on one changed line at a time, at most 200 characters, and it must not match an empty line. Make each one specific: a signal that matches ordinary lines (`import`, `return`, `=`) puts its persona on nearly every PR, and every extra persona is one more paid reviewer. At most 5 signals per persona.
- Scope globs are repo-relative, with no leading `./` or `/`.

Write ONLY a JSON array, one entry per persona, to <<<REPLY_FILE>>> with the Write tool, no other text and no code fence, then answer `done`.
[{"file": "<kebab-case>.md", "markdown": "<the full persona file>"}]
Keep the base profiles' file names for core and area personas.
