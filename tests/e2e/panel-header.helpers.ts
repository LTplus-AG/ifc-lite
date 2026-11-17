/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Locator, Page } from '@playwright/test';

/** The shared panel header (#8802) that holds the heading `title`. */
export function panelHeader(page: Page, title: string): Locator {
  return page.locator('[data-panel-header]').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

/**
 * Runs a panel header action wherever the header put it: inline while it fits
 * among the two visible actions, otherwise a row in its "More actions" menu.
 */
export async function clickPanelAction(page: Page, header: Locator, name: string): Promise<void> {
  const inline = header.getByRole('button', { name, exact: true });
  if (await inline.count() > 0) {
    await inline.click();
    return;
  }
  await header.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menu').getByRole('menuitem', { name, exact: true }).click();
}
