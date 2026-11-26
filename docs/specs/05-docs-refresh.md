# Spec: Refresh the changelog and security doc

## Problem Statement

The docs describe an older app. The changelog stops at 0.4.1 while the app
is at 1.0.6, so twelve releases are undocumented. The security doc is wrong
in four places: the backup format, the archive size limits, the trash
retention options, and language borrowed from another app, plus a credit to
validation code that no longer runs.

## Solution

Bring both docs up to the current app and record this round as the new
release.

## User Stories

1. As a user reading the changelog, I want to see what changed in every release since 0.4.1, so that I know what the app I use can do.
2. As a reviewer reading the security doc, I want the backup format described correctly, so that I am not misled about what a backup contains.
3. As a reviewer reading the security doc, I want the real archive size limits, so that I know what a crafted archive can and cannot do.
4. As a reviewer reading the security doc, I want the real trash retention options, so that I know how long deleted records are kept.
5. As a reviewer reading the security doc, I want it to talk about this app only, so that I am not confused by another app's words.
6. As a user checking the app version, I want it to read 1.0.7, so that I know this round is the version I am running.

## Implementation Decisions

- The changelog gains one line per missing release from 0.5.0 to 1.0.6, plus
  an entry for 1.0.7 describing this round.
- The security doc is corrected in four places: backup is one NDJSON file per
  store; archive limits are 100 MB and 100 MB; trash retention is only 7 or
  30 days; the other app's language and the dead validation credit are removed.
- The version is bumped to 1.0.7 in the single place the version is set; the
  displayed version follows from there.

## Testing Decisions

- No new tests. The existing suite is the check: every test still passes,
  and the app reports the new version.
- The version bump is verified by reading the displayed version in the app.

## Out of Scope

- Any behaviour change.
- Any other doc: the readme and the privacy and terms pages are already current.

## Further Notes

- The changelog entries for past releases are written from the git history
  and the released behaviour, one line each.
