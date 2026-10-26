/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { expect, test, vi } from 'vitest';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url);
test.skipIf(!existsSync(binary) || !existsSync(glue))('Node initializes published asset bytes once after sync and async failures (#8042)', async () => {
  const { initDiff, initDiffSync, diffModelConstructor } = await import('./wasm-runtime.js');
  expect(() => initDiffSync({ module: new Uint8Array([0]) })).toThrow();
  expect(() => diffModelConstructor()).toThrow(/initDiff/);
  await expect(initDiff({ module_or_path: new Uint8Array([0]) })).rejects.toThrow();
  expect(() => diffModelConstructor()).toThrow(/initDiff/);
  // #8110 review 4379165605: constructor identity cannot detect extra loads.
  // Both spies pass through to the actual filesystem and WebAssembly runtime.
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const reads = vi.spyOn(fs, 'readFile');
  const instantiations = vi.spyOn(WebAssembly, 'instantiate');
  syncBuiltinESMExports();
  const assetReads = () => reads.mock.calls.filter(([path]) => String(path).endsWith('ifc-lite-diff_bg.wasm')).length;
  try {
    // No explicit bytes: exercise the real Node asset-subpath resolution.
    await Promise.all([initDiff(), initDiff(), initDiff()]);
    expect(assetReads()).toBe(1);
    expect(instantiations).toHaveBeenCalledTimes(1);
    expect(() => diffModelConstructor()).not.toThrow();

    await initDiff();
    await initDiff({ module_or_path: new Uint8Array([0]) });
    initDiffSync({ module: new Uint8Array([0]) });
    // The read count detects a redundant facade load even when wasm-bindgen's
    // own initialized-module guard prevents a second instantiation.
    expect(assetReads()).toBe(1);
    expect(instantiations).toHaveBeenCalledTimes(1);
  } finally {
    reads.mockRestore();
    syncBuiltinESMExports();
    instantiations.mockRestore();
  }
});
