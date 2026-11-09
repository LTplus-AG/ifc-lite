/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { diffModels as oracleDiffModels } from '../test/oracle/diff.js';
import type { EntityFingerprint } from './types.js';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

// Keep this sequence in its own Vitest-isolated file: no earlier initialization
// may make the ready guard hide the async/sync race. Use real glue and bytes.
test.skipIf(!existsSync(binary) || !existsSync(glue))('pending async diff initialization rejects sync without poisoning failure/retry (#8042; missing WASM: run pnpm build:wasm)', async () => {
  const { initDiff, initDiffSync, diffModels } = await import('./index.js');
  const { diffModelConstructor } = await import('./wasm-runtime.js');
  const bytes = readFileSync(binary);
  const invalid = new Uint8Array([0]);

  // A synchronous failure must leave the runtime uninitialized and retryable.
  expect(() => initDiffSync({ module: invalid })).toThrow();
  expect(() => diffModels([], [])).toThrow(/initDiff/);

  const first = deferred<typeof bytes>();
  const failed = initDiff({ module_or_path: first.promise });
  const sentinel = new Error('deferred WASM load failed');
  const rejection = expect(failed).rejects.toBe(sentinel);
  // Valid bytes would initialize wasm-bindgen in the old runtime, then let the
  // suspended async initializer overwrite its module-global instance later.
  expect(() => initDiffSync({ module: bytes })).toThrow(/in progress.*await initDiff\(\)/);
  expect(() => diffModelConstructor()).toThrow(/initDiff/);
  expect(() => diffModels([], [])).toThrow(/initDiff/);
  first.reject(sentinel);
  await rejection;
  expect(() => diffModels([], [])).toThrow(/initDiff/);

  const retry = deferred<typeof bytes>();
  const initializing = initDiff({ module_or_path: retry.promise });
  // Concurrent callers must join this retry rather than load their own input.
  const concurrent = initDiff({ module_or_path: invalid });
  expect(() => initDiffSync({ module: bytes })).toThrow(/in progress.*await initDiff\(\)/);
  expect(() => diffModels([], [])).toThrow(/initDiff/);
  retry.resolve(bytes);
  await Promise.all([initializing, concurrent, initDiff()]);

  const ref = { callback: () => 42 };
  const base: EntityFingerprint<typeof ref>[] = [
    { key: 'wall', ifcType: 'IfcWall', dataHash: 'before', ref },
  ];
  const head = [{ ...base[0], dataHash: 'after' }];
  expect(diffModels([], [])).toEqual(oracleDiffModels([], []));
  const result = diffModels(base, head);
  expect(result).toEqual(oracleDiffModels(base, head));
  expect(result.byKey.get('wall')?.base).toBe(base[0]);
  expect(result.byKey.get('wall')?.head?.ref).toBe(ref);
  expect(result.byKey.get('wall')?.head?.ref.callback()).toBe(42);

  const { default: initialize } = await import('@ifc-lite/wasm/diff');
  const { fingerprintColumns } = await import('./wasm-columns.js');
  const exports = await initialize();
  const memory = exports.memory;
  const Model = diffModelConstructor();
  const c = fingerprintColumns(base);
  const retained = new Model(c.strings, c.fields, c.flags, c.boxes, c.volumes, c.componentOffsets, c.componentPairs);
  try {
    // Ready takes precedence over input validation and the settled pending load.
    expect(() => initDiffSync({ module: invalid })).not.toThrow();
    initDiffSync({ module: bytes });
    await initDiff({ module_or_path: invalid });
    expect((await initialize()).memory).toBe(memory);
    expect(diffModelConstructor()).toBe(Model);
    expect(retained.entityCount).toBe(1);
    expect(diffModels(base, head)).toEqual(result);
    expect(result.byKey.get('wall')?.head?.ref.callback()).toBe(42);
  } finally {
    retained.free();
  }
});
