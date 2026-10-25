# The image ReviewBench's try-agent.sh runs once per PR (see tech-design.md). Built from the repo
# root, so the skill can be copied in:
#
#   docker build --platform linux/amd64 -f tests/lens-review-eval/reviewbench/Dockerfile -t lens-review-reviewbench:dev .
#
# Deliberately no GitHub CLI and no curl: no run can reach or post to a PR.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# One exact version, so a score is tied to the Claude Code that produced it.
RUN npm install -g @anthropic-ai/claude-code@2.1.310

# The image's only skill, so its tag names the lens-review under test.
COPY skills/lens-review/ /home/node/.claude/skills/lens-review/
COPY tests/lens-review-eval/reviewbench/agent.mjs tests/lens-review-eval/reviewbench/to-reviewbench.mjs /agent/
# agent.mjs imports the skill's lib/cli.mjs by its repo-relative path, which from /agent resolves
# to /skills/lens-review/…; the link points that at the one installed copy.
RUN ln -s /home/node/.claude/skills /skills \
  && chown -R node:node /home/node/.claude

# Claude Code refuses --dangerously-skip-permissions as root.
USER node

ENTRYPOINT ["node", "/agent/agent.mjs"]
