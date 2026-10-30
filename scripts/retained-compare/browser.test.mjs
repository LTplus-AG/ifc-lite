// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const engine = process.env.IFCLITE_RETAINED_ENGINE;

test('#7955 M2-D actual Chromium session matches native corpus and f64 shape vertices', {
  timeout: 1_800_000,
  skip: !(engine && existsSync(join(engine, 'engine-manifest.json'))) && 'SKIP: no staged SMLib engine; this is NOT parity evidence',
}, async () => {
  assert.ok(process.env.IFCLITE_NATIVE_PRODUCTS, 'unmodified native products.tsv required');
  const { runBrowserComparison } = await import('./browser.mjs');
  const result = await runBrowserComparison({ engine, native: process.env.IFCLITE_NATIVE_PRODUCTS, out: process.env.IFCLITE_BROWSER_OUT });
  assert.ok(result.candidates > 0 && result.published > 0);
  assert.deepEqual(result.violations, []);
  console.log(JSON.stringify(result));
});
