/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync } from 'node:fs';
import { expect, test } from 'vitest';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url);
test.skipIf(!existsSync(binary) || !existsSync(glue))('Node initializes published asset bytes once after sync and async failures (#8042)', async () => {
  const { initDiff, initDiffSync, diffModelConstructor } = await import('./wasm-runtime.js');
  expect(() => initDiffSync({ module: new Uint8Array([0]) })).toThrow();
  expect(() => diffModelConstructor()).toThrow(/initDiff/);
  await expect(initDiff({ module_or_path: new Uint8Array([0]) })).rejects.toThrow();
  expect(() => diffModelConstructor()).toThrow(/initDiff/);
  // No explicit bytes: exercise Node's asset-subpath resolution, not fetch(file:).
  await Promise.all([initDiff(), initDiff(), initDiff()]);
  const initialized = diffModelConstructor();
  await initDiff({ module_or_path: new Uint8Array([0]) });
  expect(diffModelConstructor()).toBe(initialized);
});
