/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The inspector tells a shared type from an occurrence (#9296 lane U3):
 * before Apply to Type it says how many elements will change, Apply changes
 * every one of them in one undo step, and an occurrence with its own layers
 * is counted out and keeps them.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cleanup, click, render, type } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { typeOf } from '@/lib/commands/modeling/authored-kinds';
import { readWallMetres } from '@/store/slices/mutation-wall-resize';
import { applyMaterialLayers, createElementType, setElementType } from './inspector-edits.js';
import { ModelInspectorPanel } from './ModelInspectorPanel.js';

const s = () => useViewerStore.getState();
const live = () => modelEditTarget(s(), MODEL_ID)!;
const thickness = (id: number) => readWallMetres(live(), id)?.thickness;
const text = (ui: HTMLElement) => ui.textContent ?? '';
const radio = (ui: HTMLElement, name: string) => {
  const found = [...ui.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((el) => el.closest('label')?.textContent === name);
  assert.ok(found, `a "${name}" choice`);
  return found;
};

let walls: number[] = [];
let typeId = 0;
let restoreRemesh: () => void;
beforeEach(async () => {
  await seedModelingSession();
  restoreRemesh = setRequestRemesh(() => {});
  walls = [0, 3].map((y, i) => {
    const added = s().addWall(MODEL_ID, STOREY, { Start: [0, y, 0], End: [4, y, 0], Thickness: 0.2, Height: 3, Name: `W${i + 1}` });
    assert.ok('expressId' in added);
    return added.expressId;
  });
  const created = createElementType(MODEL_ID, 'wall', 'WT-200', walls[0]);
  assert.ok(created !== null);
  typeId = created;
  assert.equal(setElementType(MODEL_ID, walls[1], typeId), true);
  assert.equal(s().enterModelWorkspace(), true);
  s().setSelectedEntityId(toGlobalIdFromModels(s().models, MODEL_ID, walls[0]));
});
afterEach(() => {
  cleanup();
  s().exitModelWorkspace();
  restoreRemesh();
});

describe('editing a shared type from the inspector (#9296)', () => {
  it('says how many elements of the type will change before Apply, then changes all of them in one undo step', () => {
    const ui = render(<ModelInspectorPanel />);
    assert.doesNotMatch(text(ui), /of this type/, 'the element scope makes no type claim');
    act(() => click(radio(ui, 'Type')));
    assert.match(text(ui), /Changes 2 elements of this type/, 'the count is shown before Apply');
    const field = ui.querySelector<HTMLInputElement>('input[aria-label="Layer 1 thickness in metres"]')!;
    type(field, '0.3');
    const depth = s().undoStacks.get(MODEL_ID)?.length ?? 0;
    act(() => click(ui.querySelector('[data-inspector-apply-layers]')!));
    assert.deepEqual(walls.map(thickness), [.3, .3], 'every occurrence of the type takes its new total');
    const ops = s().undoStacks.get(MODEL_ID)!.slice(depth);
    assert.equal(new Set(ops.map((op) => s().mutationBatchTags.get(op.id))).size, 1, 'one undo step');
    act(() => s().undo(MODEL_ID));
    assert.deepEqual(walls.map(thickness), [.2, .2], 'one Undo puts both back');
  });

  it('counts out an occurrence with its own layers, which keeps them when the type changes', () => {
    assert.ok(applyMaterialLayers(MODEL_ID, { kind: 'wall', target: 'element', elementId: walls[1], typeId, layers: [{ thickness: .15, material: null }] }) !== null);
    const ui = render(<ModelInspectorPanel />);
    act(() => click(radio(ui, 'Type')));
    assert.match(text(ui), /Changes 1 element of this type.*1 differs from the type and keeps its layers/);
    type(ui.querySelector<HTMLInputElement>('input[aria-label="Layer 1 thickness in metres"]')!, '0.3');
    act(() => click(ui.querySelector('[data-inspector-apply-layers]')!));
    assert.deepEqual(walls.map(thickness), [.3, .15]);
  });


  it('a space can be given a new type: IfcSpaceType is a spatial type, not an element type (#9296)', () => {
    const added = s().addSpace(MODEL_ID, STOREY, { Position: [10, 10, 0], Width: 4, Depth: 3, Height: 2.8, Name: 'R1' });
    assert.ok('expressId' in added);
    const space = createElementType(MODEL_ID, 'space', 'Office', added.expressId);
    assert.ok(space !== null, 'New type… on a space is not refused');
    assert.equal(typeOf(live(), added.expressId), space);
  });
});
