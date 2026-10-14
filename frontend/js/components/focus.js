// =============================================================================
// components/focus.js — keyboard focus for the surfaces that trap it.
//
// Two surfaces in the app take the keyboard over for as long as they are open —
// the shell's mobile drawer and the modal dialogs. They used to carry their own
// copy of the same rules, which is how "Tab escapes the dialog" and "Escape
// closes nothing" bugs are born. The rules now live once, here.
//
// Public interface:
//   FOCUSABLE              the selector for everything Tab can land on
//   trapTab(box, onEscape) → keydown handler that keeps Tab inside `box`
//
// The caller owns when the trap is on: add the handler to `document` with
// `capture: true` when the surface opens, remove it when it closes. There is
// deliberately no state here, so two open at once cannot interfere.
// =============================================================================

/** What Tab can land on: real controls, never disabled or hidden ones. */
export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]),'
  + ' select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A keydown handler that keeps Tab cycling inside `container` and gives Escape
 * to `onEscape()`. Focus already inside the box simply wraps around; focus
 * outside it is pulled back in, so a stray Tab can never strand the visitor
 * behind the overlay.
 */
export function trapTab(container, onEscape) {
  return (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== 'Tab') return;

    const items = Array.from(container.querySelectorAll(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];

    if (!container.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
}
