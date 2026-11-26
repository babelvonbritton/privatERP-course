# Spec: Local timezone setting

## Problem Statement

Dates in the app can show the wrong day. An invoice created at 02:30 in the
morning prints the previous day's date, a payment recorded before 07:00 shows
the previous day in the payment list, and a pay run marked paid early in the
morning shows a paid date one day early. The stored moments are right; the
conversion to a date uses UTC instead of where the user lives.

## Solution

A dedicated "Local timezone" section in Settings where the user picks where
they live. Every date the app derives from a stored moment uses the chosen
zone. The setting defaults to the device timezone so it starts correct.

## User Stories

1. As a user in Jakarta, I want an invoice created at 02:30 local time to show 26 November, not 25 November, so that my printed invoices carry the right date.
2. As a user in Jakarta, I want a payment recorded before 07:00 to show the day I recorded it, so that my payment list matches my day.
3. As a user in Jakarta, I want a pay run marked paid early in the morning to show the right paid date in the table and on the paycheck, so that payroll records are correct.
4. As a user who travels or moves, I want to change the timezone in Settings, so that dates follow where I live now.
5. As a user opening Settings for the first time, I want the timezone to already be my device's timezone, so that I do not have to set anything.
6. As a user who values privacy, I want the app to never detect my location, so that my whereabouts are never guessed from GPS or network data.
7. As a user with no internet, I want dates to keep working, so that the app does not depend on the network to show a date.
8. As a user on a phone, I want the picker to fit a 390px screen, so that I can change the setting on my phone.
9. As a user reading the app in Indonesian, I want the section in Indonesian, so that the setting is clear in my language.

## Implementation Decisions

- The setting stores one IANA timezone name. The picker lists the platform's
  supported zones, each labelled with its UTC offset so similar names can be
  told apart.
- The setting defaults to the device timezone, read from the platform's
  date formatter at first load. Stored values that are not valid zones fall
  back to the device timezone and are reported the way other invalid
  preferences are.
- All date derivations use the chosen zone through the platform's date
  formatter with an explicit zone: dates from timestamps, today's date, the
  invoice-number day prefix, and dashboard dates. Stored timestamps stay raw
  millisecond instants and are never rewritten.
- The app loads the stored zone at boot and applies it before dates render,
  and re-renders when the setting changes, the same way the currency setting
  already works.
- No location detection of any kind is used: no GPS, no IP geolocation,
  never. No network time is used either: the bug is date conversion, not
  clock accuracy, and a network call would add an offline failure mode to a
  local-first app (recorded as an architecture decision).
- The picker uses the app's existing themed dropdown component, the same one
  the other pickers use, and follows current web guidance for select controls.

## Testing Decisions

- A good test checks behaviour through public helpers and the real UI: a
  fixed timestamp rendered under two zones, and a setting change moving the
  displayed date.
- Seams: the timezone and date helpers for the conversion rules, and the
  Settings screen for the picker itself.
- Prior art: the existing theme and currency section tests, which render the
  section and drive it through the UI, and the existing date tests.
- Expected values are known-good literals: a 02:30 WIB timestamp is 26 Nov
  under Asia/Jakarta and 25 Nov under UTC.
- Browser checks cover the Settings section at desktop width and at 390px,
  and the corrected date on a printed invoice.

## Out of Scope

- Any network time source (explicitly rejected, see the architecture decision).
- Any location detection (explicitly rejected).
- Changing how dates are stored.
- Any change to the backup format for the new setting beyond it riding in
  settings like every other preference.

## Further Notes

- The tour does not gain a step for this setting; the section explains itself.
