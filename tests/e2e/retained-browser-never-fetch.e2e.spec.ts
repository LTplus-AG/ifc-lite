/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7955 H1: the retained SMLib browser executor is opt-in. An ordinary viewer
 * load of a real model through the real WASM pipeline must never request any
 * `/smlib/` asset, never fetch the separate retained engine bundle and never
 * start the SDK module Worker. Every request the
 * page, its Workers and its nested Workers make is observed at the context.
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'fs';
import { join } from 'path';
import { ViewerBenchmarkPage } from '../benchmark/viewer-benchmark-page';

const FIXTURE = 'tests/models/ara3d/AC20-FZK-Haus.ifc';

test.describe('Retained browser executor stays opt-in', () => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing — run \`pnpm fixtures\``);

  test('an ordinary model load fetches no /smlib asset and starts no SDK Worker', async ({ page }) => {
    const requests: string[] = [];
    const workers: string[] = [];
    page.context().on('request', (request) => requests.push(request.url()));
    page.on('worker', (worker) => workers.push(worker.url()));

    const viewer = new ViewerBenchmarkPage(page);
    await viewer.setup();
    await viewer.loadFile(join(process.cwd(), FIXTURE));
    const started = Date.now();
    while (!/Geometry streaming complete: \d+ batches, \d+ meshes/.test(viewer.getConsoleLogs().join('\n'))) {
      if (Date.now() - started > 120000) throw new Error('geometry stream did not complete within 120 s');
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1000); // let deferred chunks and idle work settle

    expect(requests.some((url) => url.includes('.wasm')), 'the real engine WASM loaded').toBe(true);
    expect(requests.filter((url) => new URL(url).pathname.includes('/smlib/')), 'no /smlib request').toEqual([]);
    expect(workers.filter((url) => url.includes('smlib')), 'no SDK module Worker').toEqual([]);
    expect(requests.filter((url) => url.includes('pkg-retained')), 'no retained engine bundle').toEqual([]);
    const constructed = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('/smlib/')));
    expect(constructed, 'no /smlib resource timing entry').toEqual([]);
  });
});
