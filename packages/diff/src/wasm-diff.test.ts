/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { test, expect } from 'vitest';
import { diffModels } from './diff.js';
import { compareWithWasm } from './wasm-diff.js';
import { initDiff, initDiffSync } from './wasm-runtime.js';
import type { DiffOptions, EntityFingerprint } from './types.js';

const binary = new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
test.skipIf(!existsSync(binary))('explicit initialization and real facade preserve the diff contract (#8042; missing WASM: run pnpm build:wasm)', async () => {
  expect(() => compareWithWasm([], [])).toThrow(/initDiff/);
  // A failed load must not poison a retry, and repeated initialization is safe.
  await expect(initDiff({ module_or_path: new Uint8Array([0]) })).rejects.toThrow();
  initDiffSync({ module: readFileSync(binary) });
  await initDiff();
  const ref = { callback: () => 42 };
  const base: EntityFingerprint<typeof ref>[] = [
    { key: 'old', ifcType: 'IfcWall', dataHash: 'd', geometryHash: 42n, ref },
    { key: 'same', ifcType: 'IfcWall', dataHash: 'a', ref },
  ];
  const head = [{ ...base[0], key: 'new', geometryHash: '42' }, { ...base[1], dataHash: 'b' }];
  const options: DiffOptions[] = [
    {}, { matchUnpairedByContent: true },
    { keyAliases: new Map([['new', 'old']]) },
    { excludeTypes: new Set(['ifcwall']) },
    { matchUnpairedByContent: true, moveTolerance: NaN, reshapeTolerance: Infinity, maxMoveDistance: -Infinity },
    { detectSplitMerge: true, detectSuccessors: true, classFamilies: [] },
  ];
  for (const option of options) {
    const actual = compareWithWasm(base, head, option);
    expect(actual).toEqual(diffModels(base, head, option));
    for (const entry of actual.entries) {
      expect(actual.byKey.get(entry.key)).toBe(entry);
      if (entry.base) expect(base.includes(entry.base)).toBe(true);
      if (entry.head) expect(head.includes(entry.head)).toBe(true);
    }
  }
});
