# Spec: Remove the dead Guard validation class

## Problem Statement

The codebase carries a validation class nobody calls. Validation moved to
schemas, and a search finds zero callers of any of the class's methods. The
dead code keeps being read, worked around, and credited in docs for work it
no longer does.

## Solution

Delete the dead class and its supporting interface, keeping the error type
that is still used. Correct the documentation credit alongside the docs
refresh.

## User Stories

1. As a developer reading the code, I want validation to live in exactly one place, so that I do not have to guess which one is real.
2. As a developer reading the security doc, I want it to credit the validation that actually runs, so that I am not misled about where input limits are enforced.
3. As a user, I want nothing to change, so that removing dead code costs me no behaviour.

## Implementation Decisions

- The Guard class, its TextRules interface, and its now-unused imports are
  deleted.
- The ValidationError class and its ValidationKind type stay in the same
  file, with the same names and the same import paths, so no caller changes.
- The security doc credit is fixed as part of the docs-refresh spec, not here.

## Testing Decisions

- No new tests. The existing suite is the check: every test still passes,
  which proves no behaviour changed.
- A search for remaining references to the deleted class is part of the
  verification.

## Out of Scope

- Any change to validation behaviour or limits.
- Any change to the schemas that now own validation.
- The docs fix itself (its own spec).

## Further Notes

- None.
