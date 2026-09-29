/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model inspector's Hosting section (#6232 A1): a selected window shows
 * its host wall, "Select host" selects that wall, and its offset along the
 * wall and its sill are edited in place, each ONE undo step. And (D2) a
 * window in an IFC2X3 model offers no type: that schema has no
 * IfcWindowType.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { readHostedFill } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { blur, cleanup, click, render, type } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { setRequestRemesh, type RemeshRequest } from '@/lib/commands/modeling/transaction';
import { ModelInspectorPanel } from './ModelInspectorPanel.js';

const s = () => useViewerStore.getState();
const input = (root: HTMLElement, label: string) => {
  const found = [...root.querySelectorAll('input')].find((el) => el.getAttribute('aria-label') === label);
  assert.ok(found, `an input labelled "${label}"`);
  return found as HTMLInputElement;
};
const hosted = (id: number) => {
  const read = readHostedFill(s().models.get(MODEL_ID)!.ifcDataStore!, id, s().mutationViews.get(MODEL_ID));
  assert.ok(read);
  return { host: read.hostId, offset: +read.offset.toFixed(6), sill: +read.sill.toFixed(6) };
};

let wall = 0;
let window = 0;
let remeshed: RemeshRequest[] = [];
let restoreRemesh: () => void;
beforeEach(async () => {
  await seedModelingSession();
  remeshed = [];
  restoreRemesh = setRequestRemesh((_get, request) => { remeshed.push(request); });
  const added = s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [6, 0, 0], Thickness: 0.2, Height: 3, Name: 'W1' });
  assert.ok('expressId' in added);
  wall = added.expressId;
  const placed = s().addHostedFill(MODEL_ID, wall, { kind: 'window', params: { Offset: 2, Sill: 0.9, Width: 1.2, Height: 1.5 } });
  assert.ok('expressId' in placed, 'error' in placed ? placed.error : '');
  window = placed.expressId;
  assert.equal(s().enterModelWorkspace(), true);
  s().setSelectedEntityId(toGlobalIdFromModels(s().models, MODEL_ID, window));
});
afterEach(() => {
  cleanup();
  s().exitModelWorkspace();
  restoreRemesh();
});

describe('Hosting section (#6232 A1)', () => {
  it('shows the host wall, the offset along it and the sill', () => {
    const root = render(<ModelInspectorPanel />);
    const headings = [...root.querySelectorAll('h3')].map((h) => h.textContent);
    assert.deepEqual(headings, ['Type', 'Hosting']);
    assert.equal(root.querySelector('[data-inspector-host]')?.textContent, `W1 · IfcWall #${wall}`);
    assert.equal(input(root, 'Offset').value, '2.00');
    assert.equal(input(root, 'Sill').value, '0.90');
  });

  it('Select host selects the wall', () => {
    const root = render(<ModelInspectorPanel />);
    act(() => click(root.querySelector('[data-inspector-select-host]')!));
    assert.equal(s().selectedEntityId, toGlobalIdFromModels(s().models, MODEL_ID, wall));
  });

  it('a new offset moves the window along its wall, one undo step, and re-cuts the host', () => {
    const root = render(<ModelInspectorPanel />);
    const depth = s().undoStacks.get(MODEL_ID)?.length ?? 0;
    const offset = input(root, 'Offset');
    type(offset, '3,5');
    blur(offset);
    assert.deepEqual(hosted(window), { host: wall, offset: 3.5, sill: 0.9 });
    const [request] = remeshed;
    assert.ok(request && [window, wall].every((id) => request.expressIds.includes(id)), 'the window and its host are re-meshed');
    act(() => s().undo(MODEL_ID));
    assert.deepEqual(hosted(window), { host: wall, offset: 2, sill: 0.9 });
    assert.equal(s().undoStacks.get(MODEL_ID)?.length ?? 0, depth, 'one Ctrl+Z');
    assert.equal(input(root, 'Offset').value, '2.00', 'the field shows the old offset again');
  });

  it('a new sill raises the window, one undo step', () => {
    const root = render(<ModelInspectorPanel />);
    const sill = input(root, 'Sill');
    type(sill, '1.1');
    blur(sill);
    assert.deepEqual(hosted(window), { host: wall, offset: 2, sill: 1.1 });
    act(() => s().undo(MODEL_ID));
    assert.deepEqual(hosted(window), { host: wall, offset: 2, sill: 0.9 });
  });

  it('refuses a length that is not one, writing nothing', () => {
    const root = render(<ModelInspectorPanel />);
    const depth = s().undoStacks.get(MODEL_ID)?.length ?? 0;
    const sill = input(root, 'Sill');
    type(sill, 'high');
    blur(sill);
    assert.equal(s().undoStacks.get(MODEL_ID)?.length ?? 0, depth);
    assert.equal(input(root, 'Sill').value, '0.90');
  });

  // Review of #6476: the inspector held a moved window to no bounds; the placing command's fit rule now applies.
  it('refuses an offset or sill that takes the window out of its wall, writing nothing', () => {
    const root = render(<ModelInspectorPanel />);
    const depth = s().undoStacks.get(MODEL_ID)?.length ?? 0;
    for (const [label, text] of [['Offset', '20'], ['Offset', '5.5'], ['Sill', '2']] as const) {
      const field = input(root, label);
      type(field, text);
      blur(field);
    }
    assert.deepEqual(hosted(window), { host: wall, offset: 2, sill: 0.9 }, '1.2 m wide at 5.5 m pokes past a 6 m wall; 2 + 1.5 m past its 3 m');
    assert.equal(s().undoStacks.get(MODEL_ID)?.length ?? 0, depth);
    const edge = input(root, 'Offset');
    type(edge, '5.4');
    blur(edge);
    assert.deepEqual(hosted(window), { host: wall, offset: 5.4, sill: 0.9 }, 'flush with the wall end still fits');
  });

  it('D2: in an IFC2X3 model a window offers no type (IFC2X3 has no IfcWindowType)', () => {
    const dataStore = s().models.get(MODEL_ID)!.ifcDataStore!;
    const schema = dataStore.schemaVersion;
    dataStore.schemaVersion = 'IFC2X3';
    try {
      const root = render(<ModelInspectorPanel />);
      assert.equal(root.querySelector('[data-inspector-type]'), null, 'no type picker');
      assert.match(root.textContent ?? '', /IFC2X3 has no IfcWindowType/);
    } finally {
      dataStore.schemaVersion = schema;
    }
  });
});
