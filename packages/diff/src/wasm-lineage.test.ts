/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as oracle from './lineage.js';
import type { Lineage, RekeyPolicy } from './lineage.js';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
test.skipIf(!existsSync(binary) || !existsSync(new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url)))('WASM lineage facade preserves iterables, Map order, and optional relations (#8042)', async () => {
  const facade = await import('./wasm-lineage.js');
  const { initDiffSync } = await import('./wasm-runtime.js');
  expect(() => facade.lineageConflicts([])).toThrow(/initDiff/);
  initDiffSync({ module: readFileSync(binary) });
  const lineage: Lineage = { entries: [
    { base: ['old-z'], head: ['z'], relation: 'identity', reason: 'alias:replayed' },
    { base: ['old-a'], head: ['a'], relation: 'replaced', reason: 'successor:position' },
    { base: ['split'], head: ['piece-a', 'piece-b'], relation: 'split', reason: 'split:verified', shares: [NaN, 0.6] },
    { base: ['different'], head: ['a'], relation: 'identity', reason: 'alias:replayed' },
  ], deleted: ['gone'] };
  expect(facade.lineageConflicts(lineage.entries)).toEqual(oracle.lineageConflicts(lineage.entries));
  expect([...facade.keyAliasesFromLineage(lineage.entries)]).toEqual([...oracle.keyAliasesFromLineage(lineage.entries)]);
  // #8084: compare both engines on caller-supplied numeric evidence.
  for (const shares of [undefined, [], [0.6], [0.2, 0.6, 0.2],
    [NaN, 0.6], [0.6, NaN], [Infinity, 0.6], [0.6, Infinity],
    [-Infinity, 0.6], [0.6, -Infinity], [-0.1, 0.6], [0.6, -0.1],
    [0.5, 0.5], [0, 0], [0, 1], [2, 6], [0.4, 0.6]]) {
    const entries: Lineage['entries'] = [{ base: ['source'], head: ['a', 'b'], relation: 'split', reason: 'split:verified', shares }];
    for (const policy of ['copy-to-all', 'largest-share', 'orphan-on-split'] satisfies RekeyPolicy[]) {
      expect(facade.rekeyByLineage(['source'], entries, policy)).toEqual(oracle.rekeyByLineage(['source'], entries, policy));
    }
  }
  const keys = ['old-z', 'old-a', 'split', 'gone', 'unchanged'];
  for (const policy of ['copy-to-all', 'largest-share', 'orphan-on-split'] satisfies RekeyPolicy[]) {
    expect(facade.rekeyByLineage(new Set(keys), lineage, policy)).toEqual(oracle.rekeyByLineage(keys, lineage, policy));
    expect(facade.rekeyByLineage(keys.values(), lineage.entries, policy)).toEqual(oracle.rekeyByLineage(keys, lineage.entries, policy));
  }
});
