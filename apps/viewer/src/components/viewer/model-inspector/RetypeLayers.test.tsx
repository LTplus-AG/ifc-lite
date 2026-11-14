/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9296 (modelling parity, layered-walls row): a wall drawn with a 230 mm
 * three-layer type, given a new type from the inspector and that type's layers
 * set to 150 + 50 mm, stayed 230 mm thick on the old type's layers. The wall's
 * material usage still placed the OLD type's layer set, so it counted as
 * differing from its new type and nothing reached it.
 *
 * The inspector's own writes over a real parsed store: "New type…", "Apply to
 * Type", and picking another type from the list.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { applyAuthoredDefaults } from '@/lib/commands/modeling/authored-defaults';
import { layerSetOf, typeOf } from '@/lib/commands/modeling/authored-kinds';
import { applyMaterialLayers, createElementType, setElementType } from './inspector-edits.js';
import { typeScopeOf } from './LayersSection.js';

const s = () => useViewerStore.getState();
const live = () => ({ dataStore: s().models.get(MODEL_ID)!.ifcDataStore!, view: s().mutationViews.get(MODEL_ID) });
const layersOf = (id: number) => layerSetOf(live(), id)?.layers.map((l) => +l.thickness.toFixed(6));
const thicknessOf = (id: number) => +s().readWallEndpoints(MODEL_ID, id)!.thickness.toFixed(6);
const undoDepth = () => s().undoStacks.get(MODEL_ID)?.length ?? 0;
const named = (thickness: number, name: string) => ({ thickness, material: { name } });

let wall = 0;
let wt230 = 0;
let restoreRemesh: () => void;

beforeEach(async () => {
  await seedModelingSession();
  restoreRemesh = setRequestRemesh(() => {});
  assert.equal(s().enterModelWorkspace(), true);
  // The Wall tool's defaults: a new type, layered 115 / 100 / 15 mm.
  const type = createElementType(MODEL_ID, 'wall', 'WT-230');
  assert.ok(type !== null);
  wt230 = type;
  assert.notEqual(applyMaterialLayers(MODEL_ID, { kind: 'wall', target: 'type', typeId: wt230,
    layers: [named(0.115, 'Brick'), named(0.1, 'Insulation'), named(0.015, 'Plaster')] }), null);
  s().setAuthoringDefaults({ typeIds: { wall: { modelId: MODEL_ID, expressId: wt230 } } });
  // A wall drawn with them: typed, and placing the type's layer set through its own usage.
  const added = s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [0, 5, 0], Thickness: 0.23, Height: 3 });
  assert.ok('expressId' in added);
  wall = added.expressId;
  assert.ok(applyAuthoredDefaults(useViewerStore, MODEL_ID, [wall]));
  assert.equal(typeOf(live(), wall), wt230);
  assert.deepEqual(layersOf(wall), [0.115, 0.1, 0.015]);
  assert.equal(layerSetOf(live(), wall)?.via, 'element', 'through a usage of its own');
});

afterEach(() => {
  s().exitModelWorkspace();
  restoreRemesh();
});

describe('retyping a wall drawn with a layered type (#9296)', () => {
  it('"New type…" then "Apply to Type" with 150 + 50 mm makes the wall 200 mm on those layers', () => {
    const next = createElementType(MODEL_ID, 'wall', 'WT-200-L', wall);
    assert.ok(next !== null);
    assert.equal(typeOf(live(), wall), next);
    assert.deepEqual(layersOf(wall), [0.115, 0.1, 0.015], 'the new type starts with the layers the wall had');
    assert.equal(thicknessOf(wall), 0.23);
    assert.deepEqual(typeScopeOf(live(), next), { follow: 1, own: 0 }, 'the wall follows its new type');

    const depth = undoDepth();
    assert.notEqual(applyMaterialLayers(MODEL_ID, { kind: 'wall', target: 'type', typeId: next, elementId: wall,
      layers: [named(0.15, 'Core'), named(0.05, 'Finish')] }), null);
    assert.deepEqual(layersOf(wall), [0.15, 0.05]);
    assert.equal(thicknessOf(wall), 0.2);
    assert.deepEqual(layerSetOf(live(), wt230)?.layers.map((l) => +l.thickness.toFixed(6)), [0.115, 0.1, 0.015], 'the old type keeps its layers');

    const steps = new Set((s().undoStacks.get(MODEL_ID) ?? []).slice(depth).map((m) => s().mutationBatchTags.get(m.id)));
    assert.equal(steps.size, 1, 'layers and body are one undo step');
  });

  it('picking another layered type from the list gives the wall that type\'s layers and thickness', () => {
    const other = createElementType(MODEL_ID, 'wall', 'WT-200-L');
    assert.ok(other !== null);
    assert.notEqual(applyMaterialLayers(MODEL_ID, { kind: 'wall', target: 'type', typeId: other,
      layers: [named(0.15, 'Core'), named(0.05, 'Finish')] }), null);
    assert.equal(thicknessOf(wall), 0.23, 'another type\'s layers do not reach it');

    const depth = undoDepth();
    assert.equal(setElementType(MODEL_ID, wall, other), true);
    assert.deepEqual(layersOf(wall), [0.15, 0.05]);
    assert.equal(thicknessOf(wall), 0.2);
    assert.deepEqual(typeScopeOf(live(), other), { follow: 1, own: 0 });

    while (undoDepth() > depth) s().undo(MODEL_ID);
    assert.equal(typeOf(live(), wall), wt230, 'undo puts the old type back');
    assert.deepEqual(layersOf(wall), [0.115, 0.1, 0.015]);
    assert.equal(thicknessOf(wall), 0.23);
  });
});
