# ADR 0001: Money totals are rounded to currency precision

## Status

Accepted.

## Context

Money is stored as JavaScript numbers. Plain addition of decimal amounts
produces binary floating-point dust: 1.10 + 2.20 is 3.3000000000000003, not
3.30. Invoice totals, paid amounts, and pay-run totals were added without
rounding, so a EUR invoice paid in full could stay Partial forever, a trashed
payment could be unrestorable, and a valid backup could fail validation
because the validator re-summed payments in a different order.

## Decision

- Every money total is rounded to the currency's fraction digits (0 for IDR,
  2 for EUR and USD) at the moment it is written: invoice totals, paid
  amounts, and pay-run totals.
- Money comparisons use rounded equality: two amounts are equal when they
  round to the same value at the currency's precision.
- A paid amount that exceeds its total by at most one minor unit (rounding
  dust) is clamped to the total instead of being treated as an overpayment.
- Invoice status is derived from payments, never set directly: paid when the
  rounded paid amount reaches the rounded total, partial when some payment
  exists, sent otherwise. Overdue is derived from the due date and never
  stored.

## Consequences

- EUR and USD invoices behave like IDR ones: paying the full total reaches
  Paid, and a backup validates regardless of the order its payments are
  listed in.
- Rows written before this decision can still carry dust in storage. The
  rounded comparisons above mean they read and behave correctly; the next
  write to the row stores the rounded value.
