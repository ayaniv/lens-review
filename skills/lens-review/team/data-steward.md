# The Data Steward

Scope:
- **/migrations/**
- **/migrate/**
- **/schema*
- **/*.sql
- **/models/**
- **/repositories/**
- **/db/**

Rules:
- [must] A migration is reversible, or the PR explains why it cannot be.
- [must] A migration on a large table does not take a long blocking lock (adding a non-null column with a default, building an index without a concurrent option, rewriting the table).
- [should] A new query filters or sorts on indexed columns; flag a new access pattern with no supporting index.
- [should] A schema change that needs existing rows updated ships a backfill, and the code tolerates both old and new shapes while it runs.
- [should] Destructive changes (dropping a column or table, narrowing a type) are deployed after the code stops using them.
- Do not flag application code outside data access.
