/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model inspector panel (charter #6232, M2.5) driven the way a user does:
 * select a wall in the Model workspace, its sections show its name, type,
 * size and layers; typing a new name or thickness and committing writes ONE
 * undo step, and one undo shows the old value again.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { blur, cleanup, render, type } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { applyMaterialLayers } from './inspector-edits.js';
import { entityName, layerSetOf } from '@/lib/commands/modeling/authored-kinds';
import { ModelInspectorPanel } from './ModelInspectorPanel.js';

const s = () => useViewerStore.getState();
const undoDepth = () => s().undoStacks.get(MODEL_ID)?.length ?? 0;
const input = (root: HTMLElement, label: string) => {
  const found = [...root.querySelectorAll('input')].find((el) => el.getAttribute('aria-label') === label || (el.id && root.querySelector(`label[for="${el.id}"]`)?.textContent === label));
  assert.ok(found, `an input labelled "${label}"`);
  return found as HTMLInputElement;
};

let wall = 0;
let restoreRemesh: () => void;
beforeEach(async () => {
  await seedModelingSession();
  restoreRemesh = setRequestRemesh(() => {});
  const added = s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3, Name: 'W1' });
  assert.ok('expressId' in added);
  wall = added.expressId;
  assert.equal(s().enterModelWorkspace(), true);
  s().setSelectedEntityId(toGlobalIdFromModels(s().models, MODEL_ID, wall));
});
afterEach(() => {
  cleanup();
  s().exitModelWorkspace();
  restoreRemesh();
});

describe('ModelInspectorPanel (#6232 M2.5)', () => {
  it('shows the selected wall: header, name, size and its sections', () => {
    const root = render(<ModelInspectorPanel />);
    assert.equal(root.querySelector('[data-inspector-title]')?.textContent, `IfcWall #${wall} · L0`);
    assert.equal(input(root, 'Name').value, 'W1');
    assert.equal(input(root, 'Thickness in metres').value, '0.20');
    assert.equal(input(root, 'Height in metres').value, '3.00');
    assert.equal(input(root, 'Length in metres').readOnly, true);
    const headings = [...root.querySelectorAll('h3')].map((h) => h.textContent);
    assert.deepEqual(headings, ['Type', 'Dimensions', 'Material layers']);
  });

  it('a new name is one undo step', () => {
    const root = render(<ModelInspectorPanel />);
    const depth = undoDepth();
    const name = input(root, 'Name');
    type(name, 'Party wall');
    blur(name);
    assert.equal(entityName({ dataStore: s().models.get(MODEL_ID)!.ifcDataStore!, view: s().mutationViews.get(MODEL_ID) }, wall), 'Party wall');
    assert.equal(undoDepth(), depth + 1);
    act(() => s().undo(MODEL_ID));
    assert.equal(undoDepth(), depth);
    assert.equal(input(root, 'Name').value, 'W1', 'the field shows the old name again');
  });

  it('a new thickness is one undo step', () => {
    const root = render(<ModelInspectorPanel />);
    const depth = undoDepth();
    const field = input(root, 'Thickness in metres');
    type(field, '0,3');
    blur(field);
    assert.equal(+s().readWallEndpoints(MODEL_ID, wall)!.thickness.toFixed(6), 0.3);
    assert.equal(input(root, 'Thickness in metres').value, '0.30');
    assert.equal(input(root, 'Layer 1 thickness in metres').value, '0.30', 'an unlayered wall\'s layer draft follows its thickness');
    act(() => s().undo(MODEL_ID));
    assert.equal(undoDepth(), depth, 'one undo');
    assert.equal(+s().readWallEndpoints(MODEL_ID, wall)!.thickness.toFixed(6), 0.2);
    assert.equal(input(root, 'Thickness in metres').value, '0.20');
  });

  it('refuses a non-positive thickness without writing', () => {
    const root = render(<ModelInspectorPanel />);
    const depth = undoDepth();
    const field = input(root, 'Thickness in metres');
    type(field, '0');
    blur(field);
    assert.equal(undoDepth(), depth);
    assert.equal(input(root, 'Thickness in metres').value, '0.20', 'the field reverts');
  });
});

describe('ModelInspectorPanel dimensions of slabs, columns and beams (#6232 C4)', () => {
  const select = (expressId: number) => act(() => s().setSelectedEntityId(toGlobalIdFromModels(s().models, MODEL_ID, expressId)));
  const commitField = (root: HTMLElement, label: string, text: string) => { const field = input(root, label); type(field, text); blur(field); };
  const made = (m: { expressId: number } | { error: string }): number => { assert.ok('expressId' in m, 'error' in m ? m.error : ''); return m.expressId; };

  it('a slab\'s thickness is editable, one undo step, and re-meshes the slab', () => {
    const slab = made(s().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 }));
    select(slab);
    const root = render(<ModelInspectorPanel />);
    const field = input(root, 'Thickness in metres');
    assert.equal(field.readOnly, false, 'no longer read-only');
    const depth = undoDepth();
    commitField(root, 'Thickness in metres', '0.35');
    assert.equal(undoDepth() - depth, 1);
    assert.equal(input(root, 'Thickness in metres').value, '0.35');
    act(() => s().undo(MODEL_ID));
    assert.equal(input(root, 'Thickness in metres').value, '0.20', 'one undo');
  });

  it('a slab with layers keeps them consistent when its thickness is typed (#6232 C4)', () => {
    const slab = made(s().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 }));
    assert.notEqual(applyMaterialLayers(MODEL_ID, { kind: 'slab', target: 'element', elementId: slab, typeId: null, layers: [{ thickness: 0.1, material: { name: 'Screed' } }, { thickness: 0.1, material: { name: 'Concrete' } }] }), null);
    select(slab);
    const root = render(<ModelInspectorPanel />);
    const depth = undoDepth();
    commitField(root, 'Thickness in metres', '0.35');
    assert.equal(undoDepth() - depth >= 1, true);
    const live = { dataStore: s().models.get(MODEL_ID)!.ifcDataStore!, view: s().mutationViews.get(MODEL_ID) };
    assert.deepEqual(layerSetOf(live, slab)!.layers.map((l) => +l.thickness.toFixed(6)), [0.1, 0.25], 'the last layer took the change: 0.10 + 0.25 = 0.35');
    const tags = new Set(s().undoStacks.get(MODEL_ID)!.slice(depth).map((m) => s().mutationBatchTags.get(m.id)));
    assert.equal(tags.size, 1, 'size and layers are one undo step');
  });

  it('a column edits Width, Depth and Height; a beam Length, Width and Height, each one undo step', () => {
    const column = made(s().addColumn(MODEL_ID, STOREY, { Position: [2, 2, 0], Width: 0.3, Depth: 0.4, Height: 3 }));
    select(column);
    const root = render(<ModelInspectorPanel />);
    assert.deepEqual(['Width', 'Depth', 'Height'].map((l) => input(root, `${l} in metres`).value), ['0.30', '0.40', '3.00']);
    for (const [label, text, expected] of [['Width', '0.5', '0.50'], ['Depth', '0.6', '0.60'], ['Height', '4', '4.00']]) {
      const depth = undoDepth();
      commitField(root, `${label} in metres`, text);
      assert.equal(undoDepth() - depth, 1, `${label}: one undo step`);
      assert.equal(input(root, `${label} in metres`).value, expected);
    }

    const beam = made(s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [4, 0, 3], Width: 0.2, Height: 0.3 }));
    select(beam);
    assert.deepEqual(['Length', 'Width', 'Height'].map((l) => input(root, `${l} in metres`).value), ['4.00', '0.20', '0.30']);
    commitField(root, 'Length in metres', '5.5');
    assert.equal(input(root, 'Length in metres').value, '5.50');
    assert.equal(input(root, 'Length in metres').readOnly, false);
  });

  it('each column and beam field writes exactly its own dimension and leaves the others alone', () => {
    const column = made(s().addColumn(MODEL_ID, STOREY, { Position: [2, 2, 0], Width: 0.3, Depth: 0.4, Height: 3 }));
    select(column);
    const root = render(<ModelInspectorPanel />);
    const read = (labels: string[]) => labels.map((l) => input(root, `${l} in metres`).value);
    // [Width, Depth, Height] before -> after committing one field: only that one moves.
    for (const [label, text, expected] of [
      ['Width', '0.55', ['0.55', '0.40', '3.00']],
      ['Depth', '0.65', ['0.55', '0.65', '3.00']],
      ['Height', '4.5', ['0.55', '0.65', '4.50']],
    ] as const) {
      commitField(root, `${label} in metres`, text);
      assert.deepEqual(read(['Width', 'Depth', 'Height']), expected, `column ${label}`);
    }
    const beam = made(s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [4, 0, 3], Width: 0.2, Height: 0.3 }));
    select(beam);
    for (const [label, text, expected] of [
      ['Length', '5', ['5.00', '0.20', '0.30']],
      ['Width', '0.25', ['5.00', '0.25', '0.30']],
      ['Height', '0.45', ['5.00', '0.25', '0.45']],
    ] as const) {
      commitField(root, `${label} in metres`, text);
      assert.deepEqual(read(['Length', 'Width', 'Height']), expected, `beam ${label}`);
    }
  });

  it('a wall thickened from the inspector keeps its window cut through, in the same undo step', () => {
    const placed = s().addHostedFill(MODEL_ID, wall, { kind: 'window', params: { Offset: 2, Sill: 0.9, Width: 1, Height: 1.2 } });
    assert.ok('expressId' in placed);
    const root = render(<ModelInspectorPanel />);
    const depth = undoDepth();
    commitField(root, 'Thickness in metres', '0.6');
    assert.equal(input(root, 'Thickness in metres').value, '0.60');
    const tags = new Set(s().undoStacks.get(MODEL_ID)!.slice(depth).map((m) => s().mutationBatchTags.get(m.id)));
    assert.equal(tags.size, 1, 'the wall and its re-cut opening are one batch');
    act(() => s().undo(MODEL_ID));
    assert.equal(undoDepth(), depth, 'one undo');
  });

  it('a wall height below its window is refused and the field reverts', () => {
    const placed = s().addHostedFill(MODEL_ID, wall, { kind: 'window', params: { Offset: 2, Sill: 0.9, Width: 1, Height: 1.2 } });
    assert.ok('expressId' in placed);
    const root = render(<ModelInspectorPanel />);
    const depth = undoDepth();
    commitField(root, 'Height in metres', '1.5');
    assert.equal(undoDepth(), depth);
    assert.equal(input(root, 'Height in metres').value, '3.00');
  });
});
