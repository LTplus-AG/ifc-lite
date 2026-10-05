/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareWasmExports, declaredExports, providedExports } from './wasm-export-parity.mjs';

const DTS = `
export class ScanOutlineJs {
  free(): void;
}
export function traceScanOutline(a: Float32Array): ScanOutlineJs;
export function initSync(module: unknown): unknown;
export interface TypeOnly { a: number }
export type Alias = string;
export default function __wbg_init (x?: unknown): Promise<unknown>;
`;

const JS_FULL = `
export class ScanOutlineJs {}
export function traceScanOutline(a) {}
function initSync(m) {}
async function __wbg_init(x) {}
export { initSync, __wbg_init as default };
`;

test('declared exports skip type-only declarations and the default init', () => {
  assert.deepEqual([...declaredExports(DTS)].sort(), ['ScanOutlineJs', 'initSync', 'traceScanOutline']);
});

test('provided exports read both inline exports and the export list, aliases by public name', () => {
  assert.deepEqual([...providedExports(JS_FULL)].sort(), ['ScanOutlineJs', 'default', 'initSync', 'traceScanOutline']);
});

test('matching surfaces report nothing', () => {
  assert.deepEqual(compareWasmExports(DTS, JS_FULL), { missing: [], extra: [] });
});

// A published package built before traceScanOutline/ScanOutlineJs were added:
// the .d.ts declares them, the .js lacks them.
test('a declared symbol absent from the js is reported as missing', () => {
  const stale = JS_FULL.replace('export class ScanOutlineJs {}\n', '').replace('export function traceScanOutline(a) {}\n', '');
  assert.deepEqual(compareWasmExports(DTS, stale), {
    missing: ['ScanOutlineJs', 'traceScanOutline'],
    extra: [],
  });
});

test('a symbol the js provides beyond the d.ts is reported as extra, not missing', () => {
  const ahead = JS_FULL + 'export function newerThanCheckout() {}\n';
  assert.deepEqual(compareWasmExports(DTS, ahead), { missing: [], extra: ['newerThanCheckout'] });
});

test('an empty js is all missing, never silently equal', () => {
  assert.deepEqual(compareWasmExports(DTS, '').missing, ['ScanOutlineJs', 'initSync', 'traceScanOutline']);
});
