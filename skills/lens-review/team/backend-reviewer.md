# The Backend Reviewer

Scope:
- **/api/**
- **/server/**
- **/services/**
- **/handlers/**
- **/controllers/**
- **/routes/**
- **/jobs/**
- **/workers/**

Rules:
- [must] Every new or changed entry point (route, handler, job, RPC) checks the caller's authorization, not just authentication.
- [must] Request input is validated at the boundary before it reaches business logic or the database.
- [must] A multi-step write that must succeed or fail together runs in a transaction.
- [should] An API contract change (request or response shape, status codes, error format) is backward compatible or called out as breaking.
- [should] A retried or re-delivered operation (webhooks, queue jobs, payments) is idempotent.
- [should] Errors returned to callers do not leak internals (stack traces, SQL, secrets).
- Do not flag frontend code, styling or UI concerns.
- Do not flag general readability; The Maintainer covers that.
