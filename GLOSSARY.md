# Glossary

Domain language for Olaseena. Use these terms exactly; do not drift to synonyms.

- **Member**: a student enrolled in courses.
- **Trainer**: a teacher. Has a rate per session and a list of subjects.
- **Course**: a class members enroll in. Has a price, weekly scheduled days, and optional required skills.
- **Session**: one dated meeting of a course, taught by one trainer. Has start and end times; duration is derived from the range.
- **Attendance**: the mark (present, late, absent) for one member at one session.
- **Invoice**: a bill for one member. Has line items (called **charges** in the UI), a total, a paid amount, and a status.
- **Charge**: one line item on an invoice, with a description and an amount.
- **Payment**: one amount paid toward an invoice, with a method (cash, bank transfer, other).
- **Total**: the sum of an invoice's charges, rounded to the currency's precision.
- **Paid amount**: the sum of an invoice's payments, rounded to the currency's precision.
- **Status**: an invoice's payment state: draft, sent, partial, paid. Status is derived from payments, never set directly; overdue is derived from the due date and never stored.
- **Pay run**: one trainer's pay for one period. Has a session count, a rate per session, and a total. A draft run is recomputed from current attendance; a paid run never changes.
- **Trash**: where deleted records wait before permanent removal. Retention is 7 or 30 days.
- **Restore**: putting a trashed record (and the rows deleted with it) back. Fails loudly on conflict and changes nothing.
- **Backup**: a ZIP holding one NDJSON file per store plus a manifest, optionally passphrase-encrypted.
- **Currency**: the currency amounts are stored and shown in: IDR, EUR, or USD. Switching converts every stored amount at the live rate.
- **Rounding dust**: a difference of at most one minor currency unit (1 rupiah, 1 cent) caused by binary floating-point addition. Dust is never a real overpayment or underpayment.
- **Local timezone**: the IANA timezone the user picks in Settings. Every date shown in the app is derived from stored instants in this zone.
- **Audit log**: the append-only record of every write. Forensic only; no screen shows it.
- **Idempotency key**: a key carried by every write so repeating it returns the first result instead of writing twice.
