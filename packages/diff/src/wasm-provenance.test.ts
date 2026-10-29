/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { test, expect } from 'vitest';
import { diffModels } from '../test/oracle/diff.js';
import * as identity from '../test/oracle/identity-map.js';
import * as lineage from '../test/oracle/lineage.js';
import * as facade from './wasm-provenance.js';
import { initDiffSync } from './wasm-runtime.js';
import type { EntityFingerprint, ModelDiff, SuccessorClaim } from './types.js';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
test.skipIf(!existsSync(binary))('Rust provenance adapters preserve iterables, absent fields and opaque references (#8042)', () => {
  expect(() => facade.identityMapFromContentMatches(undefined)).toThrow(/initDiff/);
  expect(() => facade.identityMapFromSuccessors(undefined)).toThrow(/initDiff/);
  initDiffSync({ module: readFileSync(binary) });
  const entity = (key: string, hash: string, volume?: number): EntityFingerprint<never> => ({
    key, volume, ifcType: 'IfcWall', dataHash: hash,
    get ref(): never { throw new Error('opaque adapter references must not be read'); },
  });
  const base = [entity('old', 'same'), entity('gone', 'different')];
  const head = [entity('new', 'same'), entity('other', 'changed')];
  const diff = diffModels(base, head, { matchUnpairedByContent: true });
  expect(facade.identityMapFromContentMatches(diff.contentMatches?.values())).toEqual(identity.identityMapFromContentMatches(diff.contentMatches));
  const accepted: SuccessorClaim<never>[] = [{ base: base[1], head: head[1], confidence: 'position', overlap: 0, distance: 1 }];
  expect(facade.identityMapFromSuccessors(accepted.values())).toEqual(identity.identityMapFromSuccessors(accepted));
  const options = { accepted, aliasReasons: new Map([['new', 'reviewed']]) };
  expect(facade.lineageOfDiff(diff, options)).toEqual(lineage.lineageOfDiff(diff, options));
  expect(facade.lineageFromDiff(diff, { ...options, accepted: accepted.values() })).toEqual(lineage.lineageFromDiff(diff, options));
  for (const volume of [0, NaN, Infinity, 3]) for (const total of [undefined, 0, NaN, Infinity, 6]) {
    const split: ModelDiff<never> = { ...diff, contentMatches: [], splitMerges: [{
      kind: 'split', confidence: 'verified', whole: base[0],
      pieces: [entity('piece-a', 'a', volume), entity('piece-b', 'b', 3)], piecesVolume: total,
    }] };
    expect(facade.lineageOfDiff(split)).toEqual(lineage.lineageOfDiff(split));
  }
  expect(facade.identityMapFromContentMatches(undefined)).toEqual([]);
  expect(facade.identityMapFromSuccessors(undefined)).toEqual([]);
});
