/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Focused offline report witness for #8090, through the registered launcher.
 * CHROME_EXECUTABLE supplies an installed Chromium; no browser download.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

if (!process.argv[2] || !process.argv[3] || !process.env.CHROME_EXECUTABLE) {
  throw new Error('Set CHROME_EXECUTABLE and pass REPORT.html SCREENSHOT_PREFIX');
}
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 650 } });
  page.on('pageerror', error => errors.push(error.message));
  const outbound = [];
  await page.route(/^https?:/, route => { outbound.push(route.request().url()); return route.abort(); });
  await page.goto(pathToFileURL(resolve(process.argv[2])).href);
  assert.equal(await page.locator('#value').textContent(), '22.5 °C');
  assert.equal(await page.locator('#targets button').count(), 1);
  assert.equal(await page.locator('#chart circle').count(), 3);
  await page.getByRole('button', { name: 'living room' }).click();
  assert.equal(await page.getByRole('button', { name: 'living room' }).getAttribute('aria-pressed'), 'true');
  await page.getByText('Ambiguous readings — no automatic assignment', { exact: true }).click();
  assert.ok((await page.locator('#ambiguous').innerText()).includes('hall-a'));
  assert.ok((await page.locator('#ambiguous').innerText()).includes('hall-b'));
  await page.getByText('Ambiguous readings — no automatic assignment', { exact: true }).click();
  await page.screenshot({ path: `${process.argv[3]}-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 700 });
  assert.equal(await page.locator('#value').textContent(), '22.5 °C');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: `${process.argv[3]}-mobile.png`, fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(outbound, []);
  console.log(JSON.stringify({ latest: '22.5 °C', historySamples: 3, selectableEntities: 1, pageErrors: errors.length, outboundRequests: outbound.length, mobileOverflow: false }));
} finally { await browser.close(); }
