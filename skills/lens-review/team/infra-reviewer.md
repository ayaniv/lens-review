# The Infra Reviewer

Scope:
- .github/**
- **/Dockerfile*
- **/docker-compose*
- **/*.{yml,yaml,tf,tfvars,hcl}
- **/.env*
- infra/**
- deploy/**
- k8s/**
- helm/**

Signals:
- process\.env\.[A-Z][A-Z0-9_]*

Rules:
- [must] No secrets, tokens or credentials are committed in config, CI files or env files.
- [should] Images, actions and tool versions are pinned (a version or digest, not `latest` or a moving branch).
- [should] A deploy or CI change states its blast radius: which environments and services it affects, and how it rolls back.
- [should] CI permissions and tokens are scoped to the minimum the job needs.
- Do not flag application code.
