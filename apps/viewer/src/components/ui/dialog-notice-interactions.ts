/* SPDX-License-Identifier: MPL-2.0 */
import type { KeyboardEvent } from 'react';

function tabStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]')]
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled,[hidden],input[type="hidden"]')
      && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
}

/** Extend only the modal's Tab boundaries; native navigation within each surface stays intact. */
export function moveNoticeFocus(event: KeyboardEvent<HTMLElement>, panel: HTMLElement | null, shelf: HTMLElement | null): void {
  if (event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey
    || !panel || !shelf?.hasAttribute('data-dialog-notices')) return;
  const panelStops = tabStops(panel);
  const shelfStops = tabStops(shelf);
  if (!shelfStops.length) return;
  const inShelf = shelf.contains(event.target as Node);
  if (!inShelf && !panel.contains(event.target as Node)) return;
  const current = inShelf ? shelfStops : panelStops;
  const other = inShelf ? panelStops : shelfStops;
  const edge = event.shiftKey ? current[0] : current.at(-1);
  if (current.length && document.activeElement !== edge) return;
  const target = (event.shiftKey ? other.at(-1) : other[0]) ?? panel;
  event.preventDefault();
  target.focus();
}
