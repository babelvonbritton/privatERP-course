# Changelog

## 1.0.9

Ponytail tidy-up: dead code and duplicated helpers removed, shared print
header, guide button, legal page, restore decisions, table shell, and load
hook extracted so each pattern lives once. No behavior change.

## 1.0.8

The course tag inside session cards is now solid brand plum with white text, so it reads as a label instead of blending with the light soft buttons next to it.

## 1.0.7

Money rounding fixes, currency-switch status re-derivation, a Local timezone
setting in Settings, removal of the dead Guard validation class, refreshed
changelog and security doc, and the browser check wired into CI. The timezone
picker now opens with the selected zone in view: the shared dropdown caps a
long menu to the space available, which lets Radix scroll to the selected
option. A currency switch also converts the money inside live trash entries,
so a payment, invoice, pay run, course, or trainer restored after a switch
comes back in the new currency instead of smuggling old-currency amounts
into a converted invoice.

## 1.0.6

Print paycheck from payroll, for draft and paid runs, with Download PDF and
PNG.

## 1.0.5

Attendance is marking only, with an unmark action that clears a session's
marks and sends it back to the Sessions section.

## 1.0.4

Edit and delete a marked session from attendance.

## 1.0.3

Sessions are managed from the Sessions section, not from attendance.

## 1.0.2

Capacity is enforced at assignment, unassigned sessions hand nothing to
attendance, trash shows the business profile names, the tour copy is
compact with no scrolling tooltips, and every em dash is removed.

## 1.0.1

The session list moves to the course menu.

## 1.0.0

Business profile with a dashboard reminder and quick setup, and session
attendee assignment with capacity.

## 0.9.0

Required-skill tags on courses, a qualified-trainer picker on sessions,
session capacity replacing course capacity, and dashboard pagination with
the latest three invoices.

## 0.8.0

The trainer rate label follows the currency setting, sessions and
enrollments enforce the course weekly slot, and a custom time picker
replaces the native time inputs.

## 0.7.0

Google Drive backup and restore with auto-sync, a passphrase setup dialog
for sync, a refreshed tour, and a Terms page.

## 0.6.0

Courses keep weekdays only, the dashboard gains a Trainers tab, draft pay
runs refresh from current attendance, and trainer detail shows hours taught
per course.

## 0.5.0

Session start and end times with duration derived from the range, multi-day
course schedules, attended hours per course on the member detail, and the
attendance dashboard below the marking section.

## 0.4.1

Trash details: open any item in the trash bin to inspect its saved record and
related data, such as invoice payments or session attendance.

## 0.4.0

Trash bin: deleting a record now moves it to the trash instead of erasing it, with restore, permanent delete, and automatic expiry.

- Every deletable record can be trashed: members, trainers, courses,
  enrollments, sessions, invoices, payments, and pay runs. Deleting one
  removes it from its screen and puts a copy in the trash, with the rows
  deleted alongside it: a session keeps its attendance rows, an invoice
  keeps its payments. A trashed invoice keeps its attachments in place, so
  restoring it leaves them working; they are only deleted with a permanent
  delete.
- Trash keeps a record for 7 days by default, changeable to 30 days in
  Settings. Expiry is computed from the current setting, so changing it
  applies to records already in the trash. Expired records are purged
  automatically, and the trash can also be emptied by hand.
- Restore puts the record and its related rows back in one step. It fails
  loudly instead of overwriting or duplicating: a live record with the same
  id, a duplicate active enrollment, a session on the same course and date,
  a duplicate invoice number, a payment that would overpay its invoice, a
  duplicate pay run, or a missing member, course, trainer, enrollment,
  invoice, or session it depends on all block the restore and leave
  everything untouched. Every trash, restore, and permanent delete is
  written to the audit log.
- Backups now include the trash (database/trash.ndjson, schema version 3),
  so a restore brings trashed records back too, merged live-wins like the
  other stores. Backups written before the trash bin still restore exactly
  as before, with an empty trash.
- Messages files are pretty-printed (2-space indent) instead of one line,
  so they are easier to read and edit. Content is unchanged.

## 0.3.0

NDJSON backups, invoice attachments, a currency-switch refinement, a print
bugfix for legacy invoices, and a smarter invoice form.

- Backup format 2: backups are now a ZIP of manifest.json, one
  database/*.ndjson file per store (one JSON object per line), a
  settings/configuration.json file, and attachment files under
  assets/images/. The manifest records a count and sha256 for every file and
  the format version is 2. A single invalid NDJSON line is skipped with a
  warning and the rest of the file still restores; a wholly unreadable file
  fails before anything is written. Old v0.1.x and v0.2.0 backups
  (manifest.json plus data.json) still restore exactly as before, including
  their passphrase decryption. When a passphrase is set, every content file
  is encrypted with the same derived key, each with its own IV recorded in
  the manifest, and the manifest stays plain. Unpack now also caps the total
  inflated size at 100 MB and the entry count at 1000, so a crafted archive
  cannot expand without bound.
- Invoice attachments: invoices can now carry image attachments (jpg, png,
  webp, gif). Each image is compressed on the device before storing
  (longest edge 1920px, JPEG quality about 0.82) and must be at most 4 MB
  after compression, or it is rejected with a plain message. Attachment
  metadata lives in a generic store keyed by entity type and id, so the same
  uploader and viewer can later be switched on for members and sessions
  without another migration; the file bytes live in a separate blob store and
  ride in backups as real files under assets/images/, never base64 in JSON.
  The invoice shows a thumbnail list, and a lightbox viewer offers pinch
  zoom, drag pan, double-tap zoom, wheel zoom and drag on desktop, download,
  and delete behind a confirm. Escape and the close button close the viewer.
  Adding or removing an attachment is written to the audit log. A backup
  whose attachment file is missing or damaged restores anyway with a warning
  and keeps the metadata row; a file whose size does not match its details
  warns as well.
- Currency: switching currency now checks first whether any amount-bearing
  records exist. With no invoices, payments, courses, trainer rates, or
  payroll runs at all, the switch just changes the setting: no warning
  dialog, no rate fetch, and no daily switch is consumed. The audit entry
  records the change with no rate. With data present, the switch behaves
  exactly as in 0.2.0. A switch with no data does not count against the
  10-per-day limit at all.
- Print bugfix: invoices created before 0.2.0 had no payment method or
  details stored, and the print preview showed "method.undefined". Legacy
  invoices now read as cash with empty details everywhere, from one helper,
  so the preview shows no payment block and the detail view shows Cash. The
  edit dialog now has the payment method select and details field, and
  recording a payment writes the payment's method onto the invoice in the
  same step (details are never touched, and removing a payment leaves the
  method alone).
- Invoice form: picking a course now fills the first charge with the course
  title and price. Changing the course refreshes only that auto-filled
  charge, clearing the course removes only it, and charges the user typed
  are never touched. "Line items" is now plain language everywhere: the
  section is "Charges" (ID "Biaya"), the button is "Add charge" (ID "Tambah
  biaya"). The amount label next to a charge follows the current currency
  instead of always saying IDR.

## 0.2.0

Print invoices, dark theme, currency switching, and a mobile tour that
behaves like a phone sheet.

- Print invoice: invoices now carry a payment method (cash, bank transfer,
  other) and payment details (bank account or e-wallet number). The details
  field appears in the create form only when the method is not cash, and the
  detail view shows both. A preview dialog from the invoice detail offers
  Download PDF (A4, extra pages when the invoice is long) and Download PNG,
  rendered on the device with html-to-image and jsPDF. The payment block
  appears on the printed invoice only for non-cash methods, never for cash.
  Old backups without the new fields restore with cash and empty details.
- Dark theme: Settings offers Light, Dark, and Follow system (the default),
  persisted and applied before first paint so there is no flash. Every
  palette token has a dark variant in a dark plum world, not grey, and text
  contrast passes WCAG AA in both themes.
- Currency: Settings offers IDR, EUR, and USD, and every amount in the app
  follows the choice. Switching converts all stored amounts (invoice lines,
  totals and paid amounts, payments, course prices, trainer rates, payroll)
  in one atomic step at the latest rate from the Frankfurter API (ECB
  reference rates), with a second source as fallback. A confirmation dialog
  warns first that switching needs the internet and shows how many of the 10
  daily switches remain; a failed fetch changes nothing. Backups record their
  currency and a restore adopts it without converting.
- Mobile tour and polish: on narrow screens the tour is now a bottom sheet
  docked above the bottom nav, with a grabber handle, a 45dvh cap and
  internal scrolling, so the screen above stays visible; the whole-screen
  highlight ring is gone on mobile and the dim is lighter. Buttons stay
  reachable at 390x844 and 360x740. Across all eight screens, touch targets
  below 44px were raised to 44px on mobile, the footer no longer slides
  under the bottom nav on long pages, and the dashboard table region has an
  accessible name. Desktop layout and the desktop tour are unchanged.

## 0.1.1

Fixed the first-run tour trapping the user on short screens: the tooltip now
always stays fully inside the viewport (below the highlighted screen when it
fits there, above it when that fits, centered when neither side has room) and
is capped to the viewport height with scrolling. Clicking the dimmed backdrop
now ends the tour, so there is always a way out. A browser check now walks all
8 tour steps at 1280x600 and asserts the tooltip stays on screen.

## 0.1.0

First release.

- Local-first ERP for a private-course business: dashboard analytics, members,
  trainers, courses with enrollments and sessions, attendance, invoices,
  payroll, and settings.
- Bilingual English (US) and Bahasa Indonesia, IDR amounts, backup and restore
  as a versioned ZIP (optional passphrase, merge-style restore).
- First-run spotlight tour with plain-words explanations, Skip on any step
  ends the whole tour, replayable from Settings. Privacy policy page.
- Built multi-user-ready without a server: repository interfaces, actor
  context with a permission gate, org and owner ids with timestamps and
  revisions on every record, idempotency keys on every write, zod validation
  at the service boundary, append-only audit log.
- One error system for every process: failures are never silent, with readable
  messages and copyable diagnostics. Indexed search on every searchable field.
- Static export with GitHub Pages deployment, MIT license.
