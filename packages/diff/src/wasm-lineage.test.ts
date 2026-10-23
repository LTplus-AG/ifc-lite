/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as oracle from './lineage.js';
import * as facade from './wasm-lineage.js';
import { initDiffSync } from './wasm-runtime.js';
import type { Lineage, RekeyPolicy } from './lineage.js';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
test.skipIf(!existsSync(binary))('WASM lineage facade preserves iterables, Map order, and optional relations (#8042)', () => {
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
  const keys = ['old-z', 'old-a', 'split', 'gone', 'unchanged'];
  for (const policy of ['copy-to-all', 'largest-share', 'orphan-on-split'] satisfies RekeyPolicy[]) {
    expect(facade.rekeyByLineage(new Set(keys), lineage, policy)).toEqual(oracle.rekeyByLineage(keys, lineage, policy));
    expect(facade.rekeyByLineage(keys.values(), lineage.entries, policy)).toEqual(oracle.rekeyByLineage(keys, lineage.entries, policy));
  }
});
