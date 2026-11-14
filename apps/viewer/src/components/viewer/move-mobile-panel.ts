/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Move the stable portal target without losing native editing state (#9718). */
export function moveMobilePanel(parent: HTMLElement, container: HTMLElement): void {
  if (container.parentElement === parent) return;
  const active = container.ownerDocument.activeElement;
  const focused = active instanceof HTMLElement && container.contains(active) ? active : null;
  const input = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null;
  const text = input?.selectionStart !== null && input?.selectionStart !== undefined
    ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : null;
  const selection = container.ownerDocument.getSelection();
  const editable = focused?.isContentEditable && selection?.anchorNode && selection.focusNode
    ? { anchor: selection.anchorNode, start: selection.anchorOffset, focus: selection.focusNode, end: selection.focusOffset } : null;
  const scroll = container.querySelector<HTMLElement>('[data-mobile-panel-scroll]');
  const scrollTop = scroll?.scrollTop ?? 0;
  const destination = parent as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
  if (destination.moveBefore && container.isConnected && parent.isConnected) destination.moveBefore(container, null);
  else parent.appendChild(container);
  if (focused && container.ownerDocument.activeElement !== focused) focused.focus({ preventScroll: true });
  if (input && text) input.setSelectionRange(text.start, text.end, text.direction ?? undefined);
  if (editable) selection?.setBaseAndExtent(editable.anchor, editable.start, editable.focus, editable.end);
  if (scroll) scroll.scrollTop = scrollTop;
}
