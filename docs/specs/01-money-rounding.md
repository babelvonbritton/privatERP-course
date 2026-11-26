# Spec: Money rounding

## Problem Statement

A user who bills in EUR or USD can end up with an invoice that can never be
paid in full. Charges of 1.10 and 2.20 add up to 3.3000000000000003 in
floating-point math, so a payment of exactly 3.30 leaves the invoice at
Partial with a remainder too small to pay, and the invoice is stuck. The same
dust blocks restoring a deleted payment, can make the user's own backup fail
validation, and stores wrong pay-run totals. IDR users never see this because
whole rupiah have no decimals.

## Solution

Round every money total to the currency's precision at the moment it is
written, and compare money with rounded equality everywhere a total is
checked. A paid amount that overshoots its total by dust is treated as exact,
not as an overpayment.

## User Stories

1. As a user billing in EUR, I want charges of 1.10 and 2.20 to total exactly 3.30, so that the invoice shows the amount I charged.
2. As a user billing in EUR, I want a payment of 3.30 against that invoice to mark it Paid, so that the invoice is finished.
3. As a user billing in USD, I want the same behaviour as EUR, so that switching currency does not change whether an invoice can be paid.
4. As a user billing in IDR, I want nothing to change, so that whole-rupiah amounts keep working exactly as before.
5. As a user who deleted a payment by mistake, I want to restore it from the trash, so that the payment is back and the invoice total is right.
6. As a user restoring a backup, I want my own backup to validate, so that a restore is not refused over the order payments happen to be listed in.
7. As a user running payroll, I want three sessions at 0.29 to total exactly 0.87, so that the pay run shows the amount owed.
8. As a user with an invoice that was already stuck at Partial before this fix, I want it to read as Paid, so that I do not have to fix it by hand.
9. As a user recording a payment, I want an overpayment to still be refused, so that rounding tolerance never lets real money slip through.

## Implementation Decisions

- One rounding helper rounds an amount to the current currency's fraction
  digits (none for IDR, two for EUR and USD), reusing the rule the currency
  converter already applies. Every money-total write goes through it:
  invoice totals at creation, paid amounts when a payment is recorded or
  removed, pay-run totals when a run is generated or refreshed, and all
  converted totals during a currency switch.
- Money comparisons use rounded equality: two amounts are equal when they
  round to the same value at the currency's precision. This applies to the
  trash restore overpay check, the backup validator's total and paid-amount
  checks, and the integrity checker's paid mismatch check.
- A paid amount that exceeds its total by at most one minor unit (1 rupiah,
  1 cent) is clamped to the total. A larger overage is still refused.
- Invoice status keeps being derived from payments, never set directly, and
  the derivation uses the same rounded comparison, so a dusty stored row
  heals on the next write to it.
- The displayed status also treats a rounded paid amount that reaches the
  rounded total as Paid, so an already-dusty stored invoice reads correctly
  without any write.
- The two copies of the status-derivation rule (one in the invoice service,
  one in the trash service) become one shared helper, so the rule cannot drift
  apart again.

## Testing Decisions

- A good test checks behaviour through the public service interface with
  known-good literal amounts (1.10, 2.20, 3.30, 0.87), never by recomputing
  the expected value the way the code does.
- The invoice service is the seam for creation, payment, and payment removal;
  the trash service is the seam for payment restore; the backup validator is
  the seam for backup validation; the payroll service is the seam for pay-run
  totals.
- Prior art: the existing invoice payment tests and trash tests, which build
  services on a fresh in-memory database and drive them through the same
  public methods the UI uses.
- EUR and USD tests set the currency first, because amount validation follows
  the current currency's precision.
- A dusty stored invoice is tested by writing the dusty row directly and
  checking what the app shows for it.

## Out of Scope

- Currency switching status derivation (its own spec).
- Any change to how amounts are displayed or formatted.
- Any change to backup encryption, trash retention, or the audit log.

## Further Notes

- The rounding helper belongs with the existing money helpers, next to the
  currency converter it mirrors.
