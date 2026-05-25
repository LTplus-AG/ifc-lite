/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evalBundle, evalBundles, summariseEvalResults } from './harness.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const BUNDLES = join(__dirname, '..', 'fixtures', 'bundles');

describe('eval harness', () => {
  it('passes a good bundle', async () => {
    const r = await evalBundle(join(BUNDLES, 'good'));
    expect(r.passed).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('fails a broken bundle', async () => {
    const r = await evalBundle(join(BUNDLES, 'broken', 'missing-entry'));
    expect(r.passed).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('summarises a batch', async () => {
    const results = await evalBundles([
      join(BUNDLES, 'good'),
      join(BUNDLES, 'broken', 'no-manifest'),
    ]);
    const summary = summariseEvalResults(results);
    expect(summary).toContain('1/2 bundles passed');
    expect(summary).toContain('1 FAILED');
  });
});
