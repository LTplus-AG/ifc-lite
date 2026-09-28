/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model inspector's edits (charter #6232, M2.5): name, type, a wall's
 * dimensions and material layers. Each is ONE undo step however many
 * entities and relationships it writes, one Ctrl+Z puts the model back as it
 * was, and a refused edit leaves the undo stack and overlay untouched.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { setRequestRemesh, type RemeshRequest } from '@/lib/commands/modeling/transaction';
import { entityName, layerSetOf, materialsOf, typeOf, typesOfKind, type LiveModel } from '@/lib/commands/modeling/authored-kinds';
import {
  applyMaterialLayers,
  createElementType,
  renameElement,
  setElementType,
  setWallDimensions,
} from './inspector-edits.js';

let view: MutablePropertyView;
let wall = 0;
let remeshes: RemeshRequest[] = [];
let restoreRemesh: () => void;

const s = () => useViewerStore.getState();
const undoDepth = () => s().undoStacks.get(MODEL_ID)?.length ?? 0;
const live = (): LiveModel => ({ dataStore: s().models.get(MODEL_ID)!.ifcDataStore!, view: s().mutationViews.get(MODEL_ID) });
const thickness = () => s().readWallEndpoints(MODEL_ID, wall)?.thickness;
const height = () => s().readWallEndpoints(MODEL_ID, wall)?.height;
const round = (value: number | undefined) => (value === undefined ? undefined : +value.toFixed(6));

/** Assert `edit` is one undo step: it pushed at least one mutation, and a single undo restores the depth and `probe`. */
function assertOneUndoStep<T>(probe: () => T, edit: () => unknown, expected: (after: T) => void): void {
  const depth = undoDepth();
  const before = probe();
  edit();
  assert.ok(undoDepth() > depth, 'the edit was recorded');
  const tags = new Set(s().undoStacks.get(MODEL_ID)!.slice(depth).map((m) => s().mutationBatchTags.get(m.id)));
  assert.equal(tags.size, 1, 'every mutation the edit wrote carries one batch id');
  assert.ok([...tags][0], 'the batch id is set');
  expected(probe());
  s().undo(MODEL_ID);
  assert.equal(undoDepth(), depth, 'one undo reverted the whole edit');
  assert.deepEqual(probe(), before, 'and put the model back as it was');
}

beforeEach(async () => {
  view = await seedModelingSession();
  remeshes = [];
  restoreRemesh = setRequestRemesh((_get, request) => { remeshes.push(request); });
  const added = s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3, Name: 'W1' });
  assert.ok('expressId' in added);
  wall = added.expressId;
});
afterEach(() => restoreRemesh());

describe('Model inspector edits (#6232 M2.5)', () => {
  it('rename is one undo step', () => {
    assertOneUndoStep(() => entityName(live(), wall), () => {
      assert.equal(renameElement(MODEL_ID, wall, 'Party wall', 'W1'), true);
    }, (name) => assert.equal(name, 'Party wall'));
  });

  it('"New type…" creates the IfcWallType and types the wall in one undo step', () => {
    const probe = () => ({ type: typeOf(live(), wall), types: typesOfKind(live(), 'wall').map((t) => t.name) });
    assertOneUndoStep(probe, () => {
      assert.notEqual(createElementType(MODEL_ID, 'wall', 'WT-200', wall), null);
    }, (after) => {
      assert.deepEqual(after.types, ['WT-200']);
      assert.equal(after.type, typesOfKind(live(), 'wall')[0].expressId);
    });
    assert.equal(typeOf(live(), wall), null);
  });

  it('switching type, and "No type", are one undo step each and restore the previous type', () => {
    const a = createElementType(MODEL_ID, 'wall', 'A', wall)!;
    const b = createElementType(MODEL_ID, 'wall', 'B')!;
    assert.equal(typeOf(live(), wall), a);
    assertOneUndoStep(() => typeOf(live(), wall), () => assert.equal(setElementType(MODEL_ID, wall, b), true), (t) => assert.equal(t, b));
    assert.equal(typeOf(live(), wall), a);
    assertOneUndoStep(() => typeOf(live(), wall), () => assert.equal(setElementType(MODEL_ID, wall, null), true), (t) => assert.equal(t, null));
    assert.equal(typeOf(live(), wall), a);
  });

  it('a wall dimension is one undo step and re-meshes the wall', () => {
    assertOneUndoStep(() => [round(thickness()), round(height())], () => {
      assert.equal(setWallDimensions(MODEL_ID, wall, { thickness: 0.3 }), true);
    }, ([t, h]) => { assert.equal(t, 0.3); assert.equal(h, 3); });
    assert.deepEqual(remeshes.map((r) => r.expressIds), [[wall]]);
    assertOneUndoStep(() => round(height()), () => {
      assert.equal(setWallDimensions(MODEL_ID, wall, { height: 2.7 }), true);
    }, (h) => assert.equal(h, 2.7));
  });

  it('material layers on the wall (new materials, set, usage, association, thickness) are one undo step', () => {
    const probe = () => ({ layers: layerSetOf(live(), wall), materials: materialsOf(live()).map((m) => m.name), thickness: round(thickness()) });
    assertOneUndoStep(probe, () => {
      const set = applyMaterialLayers(MODEL_ID, {
        kind: 'wall', target: 'element', elementId: wall, typeId: null,
        layers: [{ thickness: 0.1, material: { name: 'Brick' } }, { thickness: 0.15, material: { name: 'Insulation' } }],
      });
      assert.notEqual(set, null);
    }, (after) => {
      assert.deepEqual(after.materials, ['Brick', 'Insulation']);
      assert.equal(after.layers?.via, 'element');
      assert.deepEqual(after.layers?.layers.map((l) => round(l.thickness)), [0.1, 0.15]);
      assert.equal(after.thickness, 0.25, 'the wall takes the layers\' total thickness');
    });
  });

  it('layers applied to the type reach the wall through it, in one undo step', () => {
    const type = createElementType(MODEL_ID, 'wall', 'WT', wall)!;
    assertOneUndoStep(() => layerSetOf(live(), wall), () => {
      assert.notEqual(applyMaterialLayers(MODEL_ID, { kind: 'wall', target: 'type', elementId: wall, typeId: type, layers: [{ thickness: 0.2, material: null }] }), null);
    }, (after) => assert.equal(after?.via, 'type'));
  });

  it('a refused edit writes nothing', () => {
    const depth = undoDepth();
    const overlay = view.getNewEntities().length;
    // #STOREY is not an IfcMaterial: the builder refuses before any layer is written.
    const set = applyMaterialLayers(MODEL_ID, {
      kind: 'wall', target: 'element', elementId: wall, typeId: null,
      layers: [{ thickness: 0.1, material: { name: 'Brick' } }, { thickness: 0.1, material: { id: STOREY } }],
    });
    assert.equal(set, null);
    assert.equal(setWallDimensions(MODEL_ID, wall, { thickness: -1 }), false);
    assert.equal(undoDepth(), depth);
    assert.equal(view.getNewEntities().length, overlay, 'no half-written material or layer set is left in the overlay');
    assert.deepEqual(materialsOf(live()), []);
    assert.equal(round(thickness()), 0.2);
  });

  it('is refused outside edit mode', () => {
    useViewerStore.setState({ editEnabled: false });
    const depth = undoDepth();
    assert.equal(renameElement(MODEL_ID, wall, 'X', 'W1'), false);
    assert.equal(undoDepth(), depth);
    assert.equal(entityName(live(), wall), 'W1');
  });
});
