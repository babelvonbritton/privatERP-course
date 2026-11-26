# Spec: Trash snapshots convert on a currency switch

## Problem Statement

Switching currency converts every live amount, but a trashed payment, a
trashed invoice with its line items, paid amount, and related payments, a
trashed pay run, a trashed course, or a trashed trainer keeps its amounts
in the old currency. Restoring one after a switch adds old-currency money
to a new-currency invoice: a payment trashed at 100,000 IDR restored after
a switch to EUR comes back as 100,000 EUR. The trash is also invisible to
the check that decides whether any amount-bearing record exists, so a
switch with only trashed money takes the no-conversion path and converts
nothing at all.

## Solution

Convert the money amounts inside live trash entries during the currency
switch, in the same transaction as the other conversions, covering every
money-bearing trash kind. Trashed money counts as amount-bearing data, so
a switch with only trashed money still fetches a rate and converts. The
conversion of a trashed invoice mirrors the live one: line items convert,
the total is re-summed from the converted items, the paid amount is
re-summed from the converted related payments, dust is clamped, and the
status is re-derived unless the invoice is a draft.

## User Stories

1. As a user who deleted a payment by mistake, I want to restore it after
   a currency switch and have it come back in the new currency, so that the
   invoice totals stay right.
2. As a user who deleted an invoice by mistake, I want to restore it after
   a currency switch and have its charges, total, and payments all in the
   new currency, so that the restored invoice is consistent.
3. As a user who deleted a pay run, a course, or a trainer, I want the
   restore after a switch to carry the new currency too, so that no trashed
   record smuggles old-currency money back in.
4. As a user switching currency with only trashed money in the app, I want
   the switch to convert it, so that the trash is not silently left behind.
5. As a user switching currency with only a trashed member and no money
   anywhere, I want the switch to stay free of a rate fetch, so that the
   no-conversion path still works when there is nothing to convert.
6. As a user restoring a trashed record after a switch, I want the same
   restore conflicts and audit entries as before, so that safety is
   unchanged.

## Implementation Decisions

- The conversion runs inside the currency-switch transaction, next to the
  live conversions, so a failure anywhere changes nothing. The trash store
  joins that transaction.
- One pure helper converts a single trash entry by kind: a trashed course
  converts its price, a trashed trainer its rate per session, a trashed
  payment its amount, a trashed pay run its rate per session with the total
  re-derived from the session count, and a trashed invoice its line items,
  total, paid amount, and related payments, with the same dust clamp and
  status re-derivation the live switch uses. Members, enrollments, and
  sessions carry no money and are left untouched.
- Money fields that are missing or not numbers are left as they are, so a
  malformed snapshot cannot fail the whole switch; such a snapshot is
  already unrestorable and the restore check still refuses it.
- The amount-bearing check counts trash entries of money-bearing kinds,
  alongside the live stores it already counts.
- The backup path needs no change: a backup restore replaces the settings
  wholesale, currency included, so live records and trash land in the
  backup's currency together and stay consistent.

## Testing Decisions

- A good test checks behaviour through the public service interface with
  known-good literal amounts: trash a fully paid 100,000 IDR payment,
  switch to EUR at the verified rate, restore it, and assert the payment
  is 6.15 EUR and the invoice is Paid with paid equal to total.
- The same shape covers a trashed invoice with line items and payments, a
  trashed pay run, course, and trainer, and a switch with only trashed
  money.
- Seams: the currency service for the switch, and the trash service for
  the restore.
- Prior art: the existing currency-switch status tests, which stub the
  rate and drive the switch through the same public method, and the trash
  tests, which trash and restore through the services.

## Out of Scope

- Any change to backup-file semantics or to what a backup restore does
  with trash.
- Any change to trash retention, restore conflicts, or the audit log.
- Converting amounts inside a backup file itself.

## Further Notes

- The converter helper is pure and kind-driven, so a new money-bearing
  trash kind in future must add its case there, next to the live
  conversion it mirrors.
