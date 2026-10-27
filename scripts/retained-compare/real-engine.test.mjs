// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { runComparison } from './run.mjs';
const engine = process.env.IFCLITE_RETAINED_ENGINE;
test('#7955 built CLI matches native codes and f64 volumes on committed models', {
  timeout: 1800000,
  skip: !(engine && existsSync(engine)) && 'SKIP: no staged SMLib engine; this is NOT parity evidence',
}, async () => {
  assert.ok(process.env.IFCLITE_NATIVE_PRODUCTS, 'native products.tsv is required');
  const result = await runComparison({ engine, native: process.env.IFCLITE_NATIVE_PRODUCTS });
  assert.equal(result.violations.length, 0);
  assert.ok(result.products > 0);
});
