/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Use the real rail, so old viewers fail plainly instead of invoking an unknown shortcut. */
export async function editCommand(s, id) {
  const full = s.page.locator(`[data-rail-tool="${id}"]`);
  if (await full.isVisible()) await s.ui.click(full);
  else {
    const rail = s.page.locator('[data-model-tool-rail]');
    if ((await rail.getAttribute('data-rail-layout')) === 'full') throw new Error(`The Edit rail offers no ${id.split('.').at(-1)} command in this viewer.`);
    await s.ui.click(s.page.locator('[data-model-tool-rail] [data-rail-group="edit"]'));
    const menu = s.page.locator(`[data-rail-menu-tool="${id}"]`);
    if (!(await menu.count())) {
      await s.ui.key('Escape');
      throw new Error(`The Edit rail offers no ${id.split('.').at(-1)} command in this viewer.`);
    }
    await s.ui.click(menu);
  }
  await s.page.locator(`[data-command-id="${id}"]`).waitFor({ timeout: 5000 });
}
