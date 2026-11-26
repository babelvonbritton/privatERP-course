# ADR 0003: The audit log is forensic only

## Status

Accepted.

## Context

Every write appends an audit entry, but no screen shows the log; it is only
visible inside a backup file. The question was whether the log is meant to
be user-visible or purely forensic.

## Decision

- The audit log is forensic only. No audit-log screen will be built.
- Entries keep being written on every write, and keep riding in backups, so
  a dispute or a bad restore can still be traced after the fact.

## Consequences

- Users never see the log in the app. That is deliberate: the log exists to
  explain what happened, not to be browsed day to day.
- If a future need for a visible history appears, it is a new decision, not
  a completion of this one.
