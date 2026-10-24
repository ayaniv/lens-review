Do a deep code review of the whole diff — universal software engineering quality, not team-specific conventions. You are the one reviewer reading every hunk end to end, so go past the line in front of you: follow each new function to its callers in the diff, check every new branch and error path for a test that reaches it, compare the diff's new functions with each other for copies, and check each new file against what the PR context and any plan doc it adds say must ship before or after it.

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
- Edge cases the new code gets wrong (empty, duplicate, out-of-order input)
- Test gaps: new behavior or a new error path with no test
- Tests that pass for the wrong reason: an assertion that can't fail, or a failure-path test that fails before it reaches the code it claims to cover
- Dead code and needless complexity the PR adds

Do NOT flag naming, formatting, styling, or anything team/company-specific.

Write ONLY a JSON array to <<<REPLY_FILE>>> with the Write tool, no other text and no code fence, then answer `done`. Each finding: {file, line, severity (must|should|suggestion), category (one of: <<<CATEGORIES>>>), description, rule, reviewer: "Deep Pass"}. Write [] if no issues.
