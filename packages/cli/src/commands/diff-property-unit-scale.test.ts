/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite diff --by-content` is a differ against a known-edit oracle: apply
 * one known edit to a fixture and the diff must report exactly that edit, no
 * more and no less.
 *
 * An `IfcPropertySingleValue` measure (`IfcLengthMeasure`, `IfcAreaMeasure`,
 * …) is stored in the project's raw author unit, exactly like an
 * `IfcElementQuantity` (`Qto_`) quantity. Before `diff-engine.ts` scaled it,
 * a wall re-exported from a metre-authored file into a millimetre-authored
 * one — same physical width, zero design edits — hashed to two different
 * `dataHash` values and was reported `modified · data`, on every quantified
 * *and* every measure-propertied element in the model.
 *
 * | Case | Expected | Before this fix | After |
 * |---|---|---|---|
 * | `Width` re-authored in a different project length unit (2.5 m ↔ 2500 mm), same physical width | `unchanged` | `modified · data` (RED) | `unchanged` (GREEN) |
 * | Control: genuine edit within one unit (2500 mm → 3000 mm) | `modified · data` | `modified · data` | `modified · data` (unaffected) |
 */

import { describe, expect, it } from 'vitest';
import { diffModels } from '@ifc-lite/diff';
import { buildFileFingerprints } from './diff-engine.js';
import { loadIfcBytes } from '../loader.js';
import {
  guid,
  UNIT_SCALE_METRE_MODEL,
  UNIT_SCALE_MILLIMETRE_EDITED_MODEL,
  UNIT_SCALE_MILLIMETRE_MODEL,
} from './diff-test-helpers.js';

async function fingerprintsOf(source: string) {
  const store = await loadIfcBytes(new TextEncoder().encode(source), 'model');
  return buildFileFingerprints(store);
}

describe('diff --by-content: measure-property unit scale', () => {
  it('does not report a re-export as changed when only the project length unit changed', async () => {
    const base = await fingerprintsOf(UNIT_SCALE_METRE_MODEL);
    const head = await fingerprintsOf(UNIT_SCALE_MILLIMETRE_MODEL);
    const diff = diffModels(base, head, { scope: 'data' });
    const wall = diff.byKey.get(guid('WALL'));
    expect(wall?.state).toBe('unchanged');
    expect(wall?.changeKinds).toEqual([]);
  });

  it('control: a genuine width edit riding on the same unit is still reported', async () => {
    const base = await fingerprintsOf(UNIT_SCALE_MILLIMETRE_MODEL);
    const head = await fingerprintsOf(UNIT_SCALE_MILLIMETRE_EDITED_MODEL);
    const diff = diffModels(base, head, { scope: 'data' });
    const wall = diff.byKey.get(guid('WALL'));
    expect(wall?.state).toBe('modified');
    expect(wall?.changeKinds).toEqual(['data']);
    expect(wall?.changedComponents).toContain('pset:Pset_X');
  });

  it('control: a genuine width edit AND a unit change together are still reported', async () => {
    const base = await fingerprintsOf(UNIT_SCALE_METRE_MODEL);
    const head = await fingerprintsOf(UNIT_SCALE_MILLIMETRE_EDITED_MODEL);
    const diff = diffModels(base, head, { scope: 'data' });
    const wall = diff.byKey.get(guid('WALL'));
    expect(wall?.state).toBe('modified');
    expect(wall?.changedComponents).toContain('pset:Pset_X');
  });
});
