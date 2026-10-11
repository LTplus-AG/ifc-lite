/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SymbolicParseCensus } from '../../apps/viewer/src/store/symbolic-parse-observer.js';

const fixture = resolve('tests/models/ara3d/AC20-FZK-Haus.ifc');
type ObservedStore = {
  getState(): {
    models: Map<string, unknown>;
    loading: boolean;
    readSymbolicParseOutcomes(): SymbolicParseCensus;
  };
};

test('authored IFC symbolic completion stays passive across canonical federation (#6537)', async ({ page }, info) => {
  test.skip(!existsSync(fixture), 'AC20-FZK-Haus.ifc missing; run pnpm fixtures');
  test.setTimeout(600_000);
  await page.goto('/');
  // Wait for the existing loader UI, independently of the observer being tested.
  await expect(page.locator('#file-input-open')).toBeAttached();
  const emptySessionReason = await page.evaluate(() => {
    const store = (globalThis as unknown as {
      __ifc_lite_viewer_store__?: ObservedStore;
    }).__ifc_lite_viewer_store__;
    return store?.getState().readSymbolicParseOutcomes?.().reason;
  });
  expect(emptySessionReason, 'an empty session cannot certify symbolic completion (#6537)').toBe('no-model');
  for (const expectedModels of [1, 2]) {
    await page.locator(expectedModels === 1 ? '#file-input-open' : '#file-input-add').setInputFiles(fixture);
    await expect.poll(() => page.evaluate(() => {
      const store = (globalThis as unknown as {
        __ifc_lite_viewer_store__?: ObservedStore;
      }).__ifc_lite_viewer_store__;
      const state = store?.getState();
      if (!state || state.loading) return null;
      const census = state.readSymbolicParseOutcomes();
      return census.status === 'complete' ? state.models.size : null;
    }), { timeout: 240_000, message: 'real IFC, overlay worker and cache reach complete observation' }).toBe(expectedModels);

    const reads = await page.evaluate(async () => {
      const store = (globalThis as unknown as {
        __ifc_lite_viewer_store__: ObservedStore;
      }).__ifc_lite_viewer_store__;
      const reads: SymbolicParseCensus[] = [];
      for (let i = 0; i < 3; i++) {
        reads.push(store.getState().readSymbolicParseOutcomes());
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      return reads;
    });
    await info.attach(`symbolic-census-${expectedModels}-models`, {
      body: JSON.stringify(reads, null, 2), contentType: 'application/json',
    });
    const first = reads[0];
    expect(first.models).toHaveLength(expectedModels);
    for (const { outcome } of first.models) {
      expect(outcome.phase).toBe('terminal');
      if (outcome.phase !== 'terminal') throw new Error('missing real worker completion');
      expect(outcome.completion.kind).toBe('success');
      expect(outcome.census.status).toBe('complete');
      if (outcome.census.status !== 'complete') throw new Error('authored source census refused');
      const counts = outcome.census;
      expect(counts.annotation.lines + counts.annotation.texts + counts.annotation.fills
        + counts.grid.lines + counts.grid.texts + counts.grid.fills,
      'authored IFC contains symbolic geometry; successful empty must not satisfy this witness').toBeGreaterThan(0);
    }
    expect(reads[1]).toEqual(first);
    expect(reads[2]).toEqual(first);
  }
});
