/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engine } from './diff-host-helpers.mjs';
import { fingerprintColumns } from '../../diff/src/wasm-columns.ts';
import { unpackDocument } from '../../diff/src/wasm-binary.ts';

test('raw resident models apply placement filtering in both transports without consuming inputs (#8042 A1)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const rows = hashes => hashes.map((geometryHash, index) => ({
    key: String(index), ifcType: 'IfcWall', dataHash: 'd', geometryHash, ref: index,
  }));
  const create = input => {
    const c = fingerprintColumns(input);
    return new wasm.DiffModel(c.strings, c.fields, c.flags, c.boxes, c.volumes, c.componentOffsets, c.componentPairs);
  };
  const base = create(rows(['p:before', 42n]));
  const head = create(rows(['p:after', undefined]));
  const strippedBase = create(rows([undefined, 42n]));
  const strippedHead = create(rows([undefined, undefined]));
  try {
    const before = base.compare(head, {});
    assert.equal(before.counts.modified, 2);
    for (const scope of ['both', 'data', 'geometry']) {
      for (const matchUnpairedByContent of [false, true]) {
        const options = { scope, matchUnpairedByContent, detectSplitMerge: true, detectSuccessors: true };
        const expected = strippedBase.compare(strippedHead, options);
        const actual = base.compare(head, { ...options, stripPlacementGeometry: true });
        assert.deepEqual(actual, expected);
        assert.equal(actual.counts.modified, 0, 'mixed capability must abstain after stripping placements');
        // Packed transport omits derivable entry keys; compare like with like.
        assert.deepEqual(unpackDocument(base.comparePacked(head, { ...options, stripPlacementGeometry: true })),
          unpackDocument(strippedBase.comparePacked(strippedHead, options)));
      }
    }
    assert.deepEqual(base.compare(head, {}), before, 'resident originals survive option toggles');
  } finally { base.free(); head.free(); strippedBase.free(); strippedHead.free(); }
});
