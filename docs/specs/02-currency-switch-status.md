# Spec: Currency switch re-derives invoice status

## Problem Statement

After switching currency, an invoice can show the wrong status. A fully paid
invoice can stay Partial because its converted payments add up to slightly
more than its converted total, and a partially paid invoice can be left with
about nothing remaining and no payment able to close it. The user did nothing
wrong: the conversion itself created the mismatch, and the switch never
re-checked the status.

## Solution

After converting an invoice's amounts, re-derive its status from the
converted amounts, and clamp a paid amount that overshoots its total by
rounding dust down to the total.

## User Stories

1. As a user switching from IDR to EUR, I want my fully paid invoices to stay Paid, so that the switch does not reopen finished work.
2. As a user switching from IDR to EUR, I want my partially paid invoices to stay Partial with a real remainder I can still pay, so that the switch does not strand them.
3. As a user switching from EUR to IDR, I want the same correct statuses, so that switching back is just as safe as switching forward.
4. As a user switching currency, I want a paid amount that overshoots its total by a cent of conversion dust to be treated as exact, so that the invoice is not left overpaid.
5. As a user switching currency, I want a genuine overpayment to still be impossible, so that the dust tolerance never hides a real mistake.

## Implementation Decisions

- The currency switch re-derives each invoice's status from its converted
  paid amount and total, using the same status-derivation rule as payments.
- The paid amount is clamped to the total when the overage is rounding dust
  (at most one minor unit), using the rounding helper from the money-rounding
  spec. The clamp runs before the status is derived.
- Pay-run totals are also rounded after conversion, so a converted run does
  not carry dust either.
- Nothing else about the switch changes: the rate is still fetched first, the
  conversion still runs in one transaction, and the daily switch limit still
  applies.

## Testing Decisions

- A good test checks behaviour through the public currency service with
  known-good literal amounts and a fixed conversion rate, never by
  recomputing the expected value the way the code does.
- The currency service is the seam. The rate fetch is stubbed at the
  network boundary so the test controls the exact rate.
- Prior art: the existing currency tests, which stub the rate fetch and drive
  the switch through the same public method the UI uses.
- Both directions are tested: IDR to EUR with a fully paid and a partially
  paid invoice, and EUR to IDR the same way.

## Out of Scope

- The rounding helper itself (its own spec).
- Any change to the rate sources, the daily switch limit, or the switch
  confirmation dialog.
- Any change to how amounts are displayed.

## Further Notes

- This spec depends on the money-rounding spec: the clamp and the rounded
  status derivation it uses are defined there.
