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
import { guid } from './diff-test-helpers.js';
import {
  UNIT_SCALE_COMBINED_METRE_MODEL,
  UNIT_SCALE_COMBINED_MILLIMETRE_MODEL,
  UNIT_SCALE_COMBINED_PROPERTY_EDITED_MODEL,
  UNIT_SCALE_COMBINED_QUANTITY_EDITED_MODEL,
  UNIT_SCALE_METRE_MODEL,
  UNIT_SCALE_MILLIMETRE_EDITED_MODEL,
  UNIT_SCALE_MILLIMETRE_MODEL,
} from './diff-unit-scale-fixtures.js';

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

/**
 * A `Qto_` quantity and a measure-typed `Pset` property are scaled through
 * two independent calls sharing one `units` value (`buildDataInput`) — a
 * rebase that combined this fix with #3549's quantity scaling threaded both
 * through that single variable. These pin each path being applied EXACTLY
 * ONCE and independently of the other: a value scaled twice by an
 * accidentally-chained implementation would read a same-unit re-export as
 * `modified`, and an edit to only one of the two would report changes on
 * both rather than the one component that actually moved.
 */
describe('diff --by-content: quantity and property unit scale do not interfere', () => {
  it('re-export into a different project unit changes neither the quantity nor the property', async () => {
    const base = await fingerprintsOf(UNIT_SCALE_COMBINED_METRE_MODEL);
    const head = await fingerprintsOf(UNIT_SCALE_COMBINED_MILLIMETRE_MODEL);
    const diff = diffModels(base, head, { scope: 'data' });
    const wall = diff.byKey.get(guid('WALL'));
    expect(wall?.state).toBe('unchanged');
    expect(wall?.changeKinds).toEqual([]);
  });

  it('a genuine quantity edit is reported on the quantity set only, not the property', async () => {
    const base = await fingerprintsOf(UNIT_SCALE_COMBINED_MILLIMETRE_MODEL);
    const head = await fingerprintsOf(UNIT_SCALE_COMBINED_QUANTITY_EDITED_MODEL);
    const diff = diffModels(base, head, { scope: 'data' });
    const wall = diff.byKey.get(guid('WALL'));
    expect(wall?.state).toBe('modified');
    expect(wall?.changedComponents).toContain('qset:Qto_WallBaseQuantities');
    expect(wall?.changedComponents).not.toContain('pset:Pset_X');
  });

  it('a genuine property edit is reported on the property set only, not the quantity', async () => {
    const base = await fingerprintsOf(UNIT_SCALE_COMBINED_MILLIMETRE_MODEL);
    const head = await fingerprintsOf(UNIT_SCALE_COMBINED_PROPERTY_EDITED_MODEL);
    const diff = diffModels(base, head, { scope: 'data' });
    const wall = diff.byKey.get(guid('WALL'));
    expect(wall?.state).toBe('modified');
    expect(wall?.changedComponents).toContain('pset:Pset_X');
    expect(wall?.changedComponents).not.toContain('qset:Qto_WallBaseQuantities');
  });
});
