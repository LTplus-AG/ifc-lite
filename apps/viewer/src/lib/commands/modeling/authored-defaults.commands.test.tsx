/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every placing command takes the Model inspector's defaults the same way
 * (charter #6232, M2.5 on top of M2.2's Slab, Column and Beam): the type
 * picked for the class it builds, and for slab-likes the layer set, land in
 * the placing command's own undo step. The Slab and Beam bars choose the
 * class (roof, member), and the defaults followed are that class's.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';
import type { SnapResult } from '@/lib/snap/types';
import type { AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';
import { applyMaterialLayers, createElementType } from '@/components/viewer/model-inspector/inspector-edits';
import './builtin.js';
import { commandPointerDown, commandPointerMove } from './runtime.js';
import { setRequestRemesh } from './transaction.js';
import { commandKind, layerSetOf, typeOf, type LiveModel } from './authored-kinds.js';

const s = () => useViewerStore.getState();
const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false });
const click = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); });
const live = (): LiveModel => ({ dataStore: s().models.get(MODEL_ID)!.ifcDataStore!, view: s().mutationViews.get(MODEL_ID) });
const undoDepth = () => s().undoStacks.get(MODEL_ID)?.length ?? 0;
const built = (ifcClass: string) => s().mutationViews.get(MODEL_ID)!.getNewEntities()
  .filter((e) => e.type.toUpperCase() === ifcClass && !s().mutationViews.get(MODEL_ID)!.isDeleted(e.expressId))
  .map((e) => e.expressId);

function pickType(kind: AuthoredElementKind): number {
  const typeId = createElementType(MODEL_ID, kind, `${kind} type`)!;
  s().setAuthoringDefaults({ typeIds: { ...s().authoringDefaults.typeIds, [kind]: { modelId: MODEL_ID, expressId: typeId } } });
  return typeId;
}

let restoreRemesh: () => void = () => {};
beforeEach(async () => {
  await seedModelingSession();
  restoreRemesh = setRequestRemesh(() => {});
  s().setAuthoringDefaults({ typeIds: {}, layerSetIds: {}, slabClass: 'slab', beamClass: 'beam', slabMode: 'rectangle', chain: false });
});
afterEach(() => {
  restoreRemesh();
  s().setAuthoringDefaults({ typeIds: {}, layerSetIds: {}, slabClass: 'slab', beamClass: 'beam' });
  s().exitModelWorkspace();
});

describe('placing commands take the inspector defaults (#6232 M2.5)', () => {
  it('the inspector edits the defaults of the class the bar builds', () => {
    const d = { slabClass: 'roof', beamClass: 'member' } as const;
    assert.deepEqual(['wall.place', 'slab.place', 'column.place', 'beam.place', 'element.split'].map((id) => commandKind(id, d)),
      ['wall', 'roof', 'column', 'member', null]);
  });

  it('column.place: the picked IfcColumnType, in the column\'s undo step', () => {
    const type = pickType('column');
    s().startCommand('column.place');
    const depth = undoDepth();
    click(2, 3);
    const [column] = built('IFCCOLUMN');
    assert.equal(typeOf(live(), column), type);
    s().undo(MODEL_ID);
    assert.equal(undoDepth(), depth, 'one undo removes the column and its typing');
    assert.equal(typeOf(live(), column), null);
  });

  it('beam.place as Member: the IfcMemberType, not the IfcBeamType', () => {
    pickType('beam');
    const member = pickType('member');
    s().setAuthoringDefaults({ beamClass: 'member' });
    s().startCommand('beam.place');
    click(0, 0);
    click(4, 0);
    const [made] = built('IFCMEMBER');
    assert.equal(typeOf(live(), made), member);
  });

  it('slab.place as Roof: the roof type and layer set, through an AXIS3 usage', () => {
    const type = pickType('roof');
    const set = applyMaterialLayers(MODEL_ID, { kind: 'roof', target: 'element', typeId: null, layers: [{ thickness: 0.25, material: { name: 'Timber' } }] })!;
    s().setAuthoringDefaults({ slabClass: 'roof', layerSetIds: { roof: { modelId: MODEL_ID, expressId: set } } });
    s().startCommand('slab.place');
    const depth = undoDepth();
    click(0, 0);
    click(3, 2);
    const [roof] = built('IFCROOF');
    assert.equal(typeOf(live(), roof), type);
    assert.equal(layerSetOf(live(), roof)?.layerSetId, set);
    s().undo(MODEL_ID);
    assert.equal(undoDepth(), depth, 'one undo removes the roof, its type and its layers');
  });
});
