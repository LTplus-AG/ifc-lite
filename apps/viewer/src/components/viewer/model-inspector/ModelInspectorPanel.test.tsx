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
import { entityName } from '@/lib/commands/modeling/authored-kinds';
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
