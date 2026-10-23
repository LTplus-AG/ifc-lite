/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Driving the Section bar's "Add plane" menu from a mounted test (#7545).
 *
 * The menu is a Radix dropdown: it opens on `pointerdown` then `click` on its
 * trigger and portals its content to `document.body`, so the item is looked up
 * there, not inside the bar.
 */

import assert from 'node:assert/strict';
import { act } from 'react';
import { click } from './render.js';

/** The Section bar, as mounted under the HUD's top-center region. */
export function sectionBar(): HTMLElement {
  const bar = document.querySelector<HTMLElement>('[data-tool-bar="section"]');
  assert.ok(bar, 'the Section bar is mounted');
  return bar;
}

/** Open the "Add plane" menu and return its portalled content. */
export function openAddPlaneMenu(): HTMLElement {
  const trigger = sectionBar().querySelector<HTMLButtonElement>('[data-testid="section-add-plane"]');
  assert.ok(trigger, 'the bar has an Add plane button (at least one plane exists)');
  act(() => { trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })); });
  click(trigger);
  const menu = document.body.querySelector<HTMLElement>('[data-testid="section-add-menu"]');
  assert.ok(menu, 'the Add plane menu opened');
  return menu;
}

/** Choose `label` ("Down (Z)", "Box", "Alignment…" …) from the Add plane menu. */
export function addPlaneFromMenu(label: string): void {
  const menu = openAddPlaneMenu();
  const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.trim() === label);
  assert.ok(item, `the Add plane menu has an item "${label}"`);
  click(item);
}
