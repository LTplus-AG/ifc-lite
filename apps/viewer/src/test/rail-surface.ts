/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the activity rail offers, read the way a user reaches it: its icons,
 * plus the entries of its More menu. On an empty viewer the panels that need
 * a model wait in More (#8802 R6), and a short rail folds the rest there too
 * (#8802 R1), so "every panel is on the rail under one name" means icon OR
 * More row, never both, and never a different name.
 *
 * Opens More to read it and closes it again (Escape), so a caller can open
 * another menu afterwards. Panel names are the visible titles: an icon's
 * `aria-label` (its title while docked or closed) and a row's title span.
 */

import assert from 'node:assert/strict';
import { act } from 'react';
import { click } from './render.js';

export interface RailSurface {
  /** Panel id -> the name the rail offers it under. */
  names: Map<string, string>;
  /** Panel id -> where: an icon on the rail, or a row in More. */
  where: Map<string, 'icon' | 'more'>;
  /** Group id -> its heading text, from the rail's divider or More's label. */
  groups: Map<string, string>;
}

export function readRailSurface(root: ParentNode = document): RailSurface {
  const names = new Map<string, string>();
  const where = new Map<string, 'icon' | 'more'>();
  const groups = new Map<string, string>();
  for (const icon of root.querySelectorAll<HTMLElement>('[data-activity-bar] button[data-tour^="activity-"]')) {
    const id = icon.dataset.tour!.slice('activity-'.length);
    names.set(id, icon.getAttribute('aria-label') ?? '');
    where.set(id, 'icon');
  }
  for (const heading of root.querySelectorAll<HTMLElement>('[data-activity-bar] [data-panel-group]')) {
    groups.set(heading.dataset.panelGroup!, heading.textContent ?? '');
  }

  const more = root.querySelector<HTMLButtonElement>('[data-activity-bar] [data-rail-overflow]');
  if (more) {
    act(() => {
      more.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    });
    click(more);
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    assert.equal(menu !== null, true, 'More opens a menu');
    for (const row of menu!.querySelectorAll<HTMLElement>('[role="menuitem"][data-panel-id]')) {
      const id = row.dataset.panelId!;
      assert.equal(where.has(id), false, `${id} is offered once: an icon or a More row, not both`);
      // The row's own title, not its trailing state hint ("open a model first").
      names.set(id, row.querySelector(':scope > span')?.textContent?.trim() ?? '');
      where.set(id, 'more');
    }
    for (const label of menu!.querySelectorAll<HTMLElement>('[data-panel-group]')) {
      if (!groups.has(label.dataset.panelGroup!)) groups.set(label.dataset.panelGroup!, label.textContent ?? '');
    }
    act(() => {
      menu!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
  }
  return { names, where, groups };
}
