The team has finished its first pass. Below are the merged findings from every reviewer on this PR. Skip every finding whose `reviewers` include your own persona name; you don't vote on your own findings.

Stay in your persona and apply your own lens and your "Do not flag" rules. For each finding, decide:
- **agree** — the issue is real and worth raising, as described, at that file and line.
- **dispute** — it is not real, not at that line, already handled elsewhere in the diff, or a pattern applied too broadly. Say what you saw that the reviewer missed.

Vote only where you have a grounded opinion: skip a finding entirely when it is outside your lens and you have no evidence either way. A dispute must cite the diff (file and line, or the code that handles it); "I don't think so" is not a reason.

MERGED FINDINGS:
<<<MERGED_FINDINGS>>>

Return ONLY JSON, no other text and no code fence:
{"persona": "<your persona name, exactly as in your persona file>", "votes": [{"id": "F<n>", "verdict": "agree" | "dispute", "reason": "<one sentence>"}]}
Return `"votes": []` if you have no grounded opinion on any finding.
