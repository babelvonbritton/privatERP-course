# Spec: Timezone picker scrolls to the selected zone

## Problem Statement

The Local timezone picker lists 419 zones. After picking Asia/Jakarta,
reopening the picker shows the top of the list (Africa/Abidjan) instead of
the selected zone, so the user must scroll through hundreds of entries to
find where they are. The cause sits in the shared dropdown component: it
uses Radix Select with `position="popper"`, and in that mode Radix never
runs its scroll-to-selected behaviour, while nothing caps the menu height,
so the menu renders about 15,000px tall and the selected zone sits far
below the fold, unreachable by scrolling.

## Solution

An opt-in on the shared dropdown, used only by the timezone picker, that
caps the menu to the space available so the list can scroll inside it.
Radix already scrolls the selected option into view once the menu is
placed; the cap is what makes that scroll able to move anything. The other
dropdowns that share the component keep their current behaviour.

## User Stories

1. As a user who picked Asia/Jakarta, I want reopening the picker to show
   Asia/Jakarta in view, so that I can confirm my setting at a glance.
2. As a user on a phone, I want the same when I open the picker at 390px,
   so that the long list is usable on a small screen.
3. As a user opening any other dropdown, I want nothing to change, so that
   short lists keep opening exactly as they do now.
4. As a user who picks a zone near the end of the list, I want it in view
   on open too, so that the fix is not specific to one zone.

## Implementation Decisions

- The shared dropdown gains one opt-in prop, used only by the timezone
  section. No other caller passes it, and no other caller changes.
- The cap uses the available-height variable Radix already exposes on the
  menu, so the menu fits the screen instead of rendering at its full
  natural height. No explicit scroll is added: Radix scrolls the selected
  option into view once the menu is placed, and the cap is what lets that
  scroll move the list. This was verified in the real browser: with the cap
  the menu scrolls to Asia/Jakarta on open, without it the selected option
  sits about 9,000px below the fold.
- The scroll targets the checked option inside the open menu and uses the
  nearest scroll position, so the list moves as little as needed.
- The scroll runs after the menu mounts, not in the open handler itself,
  because the options are only in the document once the menu has opened.

## Testing Decisions

- A good test checks the opt-in wiring through the real section and the
  shared dropdown: the menu carries the height cap with the opt-in and not
  without it. Whether the selected option is actually in view is a layout
  fact jsdom cannot measure, so the browser check asserts it.
- Seams: the shared dropdown for the opt-in wiring, and the timezone
  section for the picker itself.
- Expected values are known-good literals: the Asia/Jakarta option is the
  checked one and the one in view on open.
- Browser checks open the picker after picking Asia/Jakarta and assert the
  selected option sits inside the visible menu, at desktop width and at
  390px.

## Out of Scope

- Any redesign of the shared dropdown or change to its behaviour for other
  callers.
- Any change to the timezone setting itself or to how dates are derived.
- Keyboard typeahead in the picker.

## Further Notes

- The mockup for this fix is the picker open at Asia/Jakarta, desktop and
  mobile, replacing the v1.0.7 shot that shows Africa/Abidjan at the top.
