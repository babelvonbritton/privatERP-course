# ADR 0002: No network time for the local timezone

## Status

Accepted.

## Context

Dates derived from stored timestamps used UTC, so a record made before
07:00 local time printed the previous day. The fix is a user-picked local
timezone setting, and every date derivation converts the stored instant
into that zone.

## Decision

- The app never fetches the time from the network. No NTP, no network time
  call of any kind.
- Dates are converted from stored millisecond instants into the chosen zone
  with offset math in the platform's date formatter. The bug is date
  conversion, not clock accuracy.
- The setting defaults to the device timezone and the user can change it
  anytime. No location detection of any kind is used: no GPS, no IP
  geolocation, never.

## Consequences

- A network time call would add an offline failure mode to a local-first
  app and cannot fix timestamps already stored, so it buys nothing here.
- If the device clock itself is wrong, dates can still be wrong. That is
  the device's problem to fix, not the app's; the app never corrects the
  clock.
