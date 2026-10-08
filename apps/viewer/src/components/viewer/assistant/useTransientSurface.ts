/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keyboard contract for the Assistant's inline transient surfaces (#6926):
 * the citation peek, the saved-conversations library and the source picker.
 *
 * - Opening moves focus into the surface so a screen reader reads it.
 * - Escape closes the innermost surface, through the command layer's
 *   `ui.closeOverlay` binding (the same one Customize sidebar uses), and only
 *   while focus is inside it. Elsewhere Escape keeps its global meaning
 *   (clear selection, double Escape closes panels); it never cancels a
 *   running request.
 * - Closing returns focus to whatever opened it, or to `fallback` (a selector
 *   resolved inside `scope`) when that element has been replaced, but only if
 *   focus would otherwise be lost: it never pulls focus from where the user
 *   has since moved it.
 */

import { useEffect, useRef, type RefObject } from 'react';
import { registerKeyboardCommand } from '@/lib/commands/dispatcher';

function focusLost(surface: HTMLElement | null): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected || (surface?.contains(active) ?? false);
}

export function useTransientSurface<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onClose: () => void,
  restore: { fallback?: string; scope?: RefObject<HTMLElement | null> } = {},
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const { fallback, scope } = restore;
  useEffect(() => {
    const surface = ref.current;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : null;
    surface?.focus({ preventScroll: true });
    const removeEscape = registerKeyboardCommand('ui.closeOverlay', () => { closeRef.current(); }, {
      layer: 'popover', allowInTextEntry: true, ignoreModifiers: true,
      active: () => !!surface && surface.contains(document.activeElement),
    });
    return () => {
      removeEscape();
      if (!focusLost(surface)) return;
      const target = opener?.isConnected ? opener
        : fallback ? (scope?.current ?? document).querySelector<HTMLElement>(fallback) : null;
      target?.focus({ preventScroll: true });
    };
  }, [ref, fallback, scope]);
}
