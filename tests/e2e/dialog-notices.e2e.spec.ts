/* SPDX-License-Identifier: MPL-2.0 */
import { test, expect } from '@playwright/test';

test('#9879 a modal notice stays outside the panel and participates in keyboard focus and dismissal', async ({ page }) => {
  // Hold the real privacy-disclosure timer until Settings is open.
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  });
  await page.goto('/');
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
  await page.locator('[data-command-id="pref:settings"]').click({ force: true });
  const dialog = page.locator('[data-settings-dialog]');
  await expect(dialog).toBeVisible();
  const tab = dialog.getByRole('tab', { name: 'Performance', exact: true });
  const before = await tab.boundingBox();
  await page.clock.resume();
  const notice = page.locator('[data-dialog-notices]').filter({ hasText: 'IFClite stores an action log' });
  await expect(notice).toBeVisible({ timeout: 15000 });
  expect(await tab.boundingBox()).toEqual(before);
  expect(await notice.evaluate(element => !element.closest('[data-dialog-panel]'))).toBe(true);
  expect(await tab.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  })).toBe(true);
  const action = notice.getByRole('button', { name: 'Privacy settings', exact: true });
  await action.focus();
  await expect(action).toBeFocused();
  await page.keyboard.press('Tab');
  const dismiss = notice.getByRole('button', { name: 'Dismiss notification', exact: true });
  await expect(dismiss).toBeFocused();
  await dismiss.click();
  await expect(notice).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);
});
