/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { expect, test, vi } from 'vitest';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url);

// #8042 / #8110 review 4379165605: this file needs its own isolated runtime;
// the async-first tests cannot establish synchronous-to-asynchronous reuse.
test.skipIf(!existsSync(binary) || !existsSync(glue))('sync-first initialization reuses real WASM without an async asset read (#8042; missing WASM: run pnpm build:wasm)', async () => {
  const bytes = readFileSync(binary);
  const { initDiff, initDiffSync, diffModelConstructor } = await import('./wasm-runtime.js');
  expect(() => diffModelConstructor()).toThrow(/initDiff/);
  initDiffSync({ module: bytes });
  expect(() => diffModelConstructor()).not.toThrow();

  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const reads = vi.spyOn(fs, 'readFile');
  const instantiations = vi.spyOn(WebAssembly, 'instantiate');
  syncBuiltinESMExports();
  try {
    await Promise.all([initDiff(), initDiff({ module_or_path: new Uint8Array([0]) })]);
    expect(reads).not.toHaveBeenCalled();
    expect(instantiations).not.toHaveBeenCalled();
    expect(() => diffModelConstructor()).not.toThrow();
  } finally {
    reads.mockRestore();
    syncBuiltinESMExports();
    instantiations.mockRestore();
  }
});
