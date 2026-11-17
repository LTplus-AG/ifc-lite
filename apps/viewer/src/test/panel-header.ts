/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reaching a shared panel header action (#8802) from a test. The header shows
 * at most two actions inline and lists the rest in its "More actions" menu,
 * so a test that cares about the action, not where it renders, finds it in
 * either place.
 */

import { advance, click, press } from './render.js';

const inline = (root: ParentNode, label: string): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>('button[data-panel-action]')].find((button) => button.getAttribute('aria-label') === label);

/** Opens the More actions menu of the header inside `root`; resolves its rows. */
export async function openPanelOverflow(root: ParentNode): Promise<HTMLElement[]> {
  const more = root.querySelector<HTMLElement>('[data-panel-header] button[data-panel-overflow]');
  if (!more) return [];
  press(more, 'ArrowDown');
  await advance(10);
  return [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [data-panel-action]')];
}

/**
 * The control for header action `label`: its inline button, or its row in the
 * opened More actions menu. Undefined when the header does not offer it.
 */
export async function findPanelAction(root: ParentNode, label: string): Promise<HTMLElement | undefined> {
  return inline(root, label)
    ?? (await openPanelOverflow(root)).find((row) => row.textContent?.trim() === label);
}

/** Runs header action `label` the way a user would; throws when it is not offered. */
export async function runPanelAction(root: ParentNode, label: string): Promise<void> {
  const control = await findPanelAction(root, label);
  if (!control) throw new Error(`panel header offers no "${label}" action`);
  if (control.tagName === 'BUTTON') {
    click(control);
  } else {
    press(control, 'Enter');
  }
  await advance(10);
}
