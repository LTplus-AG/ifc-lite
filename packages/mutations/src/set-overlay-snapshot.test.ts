/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5965: every whole-set edit records its set's overlay state on either side,
 * and restoring `before` / `after` is an exact undo / redo. The invariant
 * pinned here: the view reads (`getForEntity`, `getQuantitiesForEntity`,
 * `hasChanges`) after restoring `before` equal the reads taken before the
 * edit, and after restoring `after` equal the reads taken right after it.
 */

import { describe, expect, it } from 'vitest';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { MutablePropertyView } from './mutable-property-view.js';
import type { Mutation } from './types.js';

const WALL = 7;

function viewWithBaseSets(): MutablePropertyView {
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id) => id === WALL
    ? [{
      name: 'Custom_A',
      globalId: 'psa',
      properties: [
        { name: 'A1', type: PropertyValueType.Label, value: 'a1' },
        { name: 'A2', type: PropertyValueType.Label, value: 'a2' },
      ],
    }]
    : []);
  view.setQuantityExtractor((id) => id === WALL
    ? [{
      name: 'Qto_WallBaseQuantities',
      quantities: [
        { name: 'Length', type: QuantityType.Length, value: 4 },
        { name: 'Height', type: QuantityType.Length, value: 3 },
      ],
    }]
    : []);
  return view;
}

function reads(view: MutablePropertyView) {
  return {
    psets: view.getForEntity(WALL).map((p) => ({ name: p.name, props: p.properties.map((q) => `${q.name}=${String(q.value)}`) })),
    qsets: view.getQuantitiesForEntity(WALL).map((q) => ({ name: q.name, quantities: q.quantities.map((x) => `${x.name}=${x.value}`) })),
    changed: view.hasChanges(WALL),
  };
}

/** Run `edit`, then undo and redo it twice from the mutation's snapshots. */
function expectExactUndoRedo(view: MutablePropertyView, edit: () => Mutation | null): void {
  const beforeEdit = reads(view);
  const mutation = edit();
  expect(mutation?.setOverlay).toBeDefined();
  const afterEdit = reads(view);
  expect(afterEdit).not.toEqual(beforeEdit);
  for (let round = 0; round < 2; round += 1) {
    view.restoreSetOverlay(mutation!.setOverlay!.before);
    expect(reads(view)).toEqual(beforeEdit);
    view.restoreSetOverlay(mutation!.setOverlay!.after);
    expect(reads(view)).toEqual(afterEdit);
  }
}

describe('whole-set edits restore exactly from their set snapshots (#5965)', () => {
  it('createPropertySet on an untouched entity: undo leaves no trace of the set', () => {
    const view = viewWithBaseSets();
    const mutation = view.createPropertySet(WALL, 'Custom_New', [{ name: 'N1', value: 'n1' }]);
    view.restoreSetOverlay(mutation.setOverlay!.before);
    expect(view.hasChanges(WALL)).toBe(false);
    expectExactUndoRedo(view, () => view.createPropertySet(WALL, 'Custom_New', [{ name: 'N1', value: 'n1' }]));
  });

  it('createPropertySet over an in-session set of the same name: undo brings its old members back', () => {
    const view = viewWithBaseSets();
    view.createPropertySet(WALL, 'Custom_New', [{ name: 'N1', value: 'n1' }, { name: 'N2', value: 'n2' }]);
    expectExactUndoRedo(view, () => view.createPropertySet(WALL, 'Custom_New', [{ name: 'N3', value: 'n3' }]));
  });

  it('deletePropertySet on a file set with an edited member: undo restores every member, edit included', () => {
    const view = viewWithBaseSets();
    view.setProperty(WALL, 'Custom_A', 'A1', 'a1-edited');
    view.setProperty(WALL, 'Custom_A', 'A3', 'a3');
    expectExactUndoRedo(view, () => view.deletePropertySet(WALL, 'Custom_A'));
  });

  it('createQuantitySet, deleteQuantitySet and deleteQuantity each undo and redo exactly', () => {
    const view = viewWithBaseSets();
    expectExactUndoRedo(view, () => view.createQuantitySet(WALL, 'Qto_Custom', [
      { name: 'Volume', value: 12, quantityType: QuantityType.Volume },
    ]));
    view.setQuantity(WALL, 'Qto_WallBaseQuantities', 'Length', 5, QuantityType.Length);
    expectExactUndoRedo(view, () => view.deleteQuantity(WALL, 'Qto_WallBaseQuantities', 'Height'));
    expectExactUndoRedo(view, () => view.deleteQuantitySet(WALL, 'Qto_WallBaseQuantities'));
  });

  it('a snapshot is a copy: editing the set after recording does not rewrite it', () => {
    const view = viewWithBaseSets();
    const created = view.createPropertySet(WALL, 'Custom_New', [{ name: 'N1', value: 'n1' }]);
    view.setProperty(WALL, 'Custom_New', 'N1', 'changed');
    view.setProperty(WALL, 'Custom_New', 'N2', 'n2');
    view.restoreSetOverlay(created.setOverlay!.after);
    expect(reads(view).psets.find((p) => p.name === 'Custom_New')?.props).toEqual(['N1=n1']);
  });
});
