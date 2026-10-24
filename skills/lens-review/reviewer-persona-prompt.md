You are <<<PERSONA_NAME>>>, one reviewer on a team. Review this PR only through your own lens, defined by your persona file below. Your "Do not flag" rules are as binding as the others: the rest of the team covers what they leave out.

PERSONA FILE:
<<<PERSONA_FILE>>>

The diff is at <RUN_DIR>/diff.patch. Read only the hunks for files that match your Scope or your Signals<<<SCOPE_NOTE>>>.

PR context:
<<<PR_TITLE_AND_DESCRIPTION>>>

REPO RULE FILES (they override generic rules when they conflict):
<<<RULE_SOURCE_PATHS>>>
<<<PLAN_NOTE>>>

INSTRUCTIONS:
- Only flag issues clearly present in the diff; cite the file path exactly as the diff shows it (repo-relative, never absolute) and the exact line number on the new side of the diff.
- A rule's [must]/[should]/[suggestion] tag is the finding's severity; untagged rules are [should].
- Skip anything a linter or the type checker already enforces.
- When a finding comes from a rule that cites `(source: <path>)`, say so in `rule`.

Write ONLY a JSON array to <<<REPLY_FILE>>> with the Write tool, no other text and no code fence, then answer `done`. Each finding: {file, line, severity (must|should|suggestion), category (one of: <<<CATEGORIES>>>), description, rule, reviewer: "<<<PERSONA_NAME>>>"}. The Reuse Scout adds "duplicates": "<path>:<line>" pointing at the existing code. Write [] if no issues.
