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
import { placedBodyExtent, readHostedElementSize, readHostedFill } from '@ifc-lite/create';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
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
  for (const modelCount of [1, 2]) it(`hosted dimension inputs resolve overlay ownership with ${modelCount} model(s), independently of the active model (#6232)`, async () => {
    const owner = { ...s().models.get(MODEL_ID)!, idOffset: 1_000_000, maxExpressId: 139 };
    const models = new Map([[MODEL_ID, owner]]);
    let decoyView: MutablePropertyView | undefined;
    const ownerView = s().mutationViews.get(MODEL_ID)!;
    if (modelCount === 2) {
      const source = owner.ifcDataStore!.source;
      const data = await source.withMaterializedAsync(bytes => new IfcParser().parseColumnar(Uint8Array.from(bytes).buffer, { disableWorkerScan: true }));
      const decoy = { ...owner, id: 'decoy', name: 'decoy', idOffset: 0, ifcDataStore: data };
      models.set('decoy', decoy);
      decoyView = new MutablePropertyView(data.properties ?? null, 'decoy');
      useViewerStore.setState({ models, mutationViews: new Map([[MODEL_ID, ownerView], ['decoy', decoyView]]) });
      const decoyWall = s().addWall('decoy', STOREY, { Start: [0, 0, 0], End: [6, 0, 0], Thickness: 0.2, Height: 3, Name: 'Decoy wall' });
      assert.ok('expressId' in decoyWall);
      const decoyWindow = s().addHostedFill('decoy', decoyWall.expressId, { kind: 'window', params: { Offset: 2, Sill: 0.9, Width: 1.2, Height: 1.5 } });
      assert.ok('expressId' in decoyWindow);
      assert.equal(decoyWindow.expressId, window, 'independently authored models have colliding local overlay ids');
      useViewerStore.setState({ activeModelId: 'decoy', ifcDataStore: data, session: { ...s().session!, modelId: 'decoy' } });
    }
    useViewerStore.setState({ models });
    s().setSelectedEntityId(toGlobalIdFromModels(models, MODEL_ID, window));
    const root = render(<ModelInspectorPanel />);
    const originalDepth = s().undoStacks.get(MODEL_ID)?.length ?? 0;
    const decoyDepth = s().undoStacks.get('decoy')?.length ?? 0;
    const decoyShape = decoyView ? placedBodyExtent(models.get('decoy')!.ifcDataStore!, window, decoyView) : null;
    remeshed = [];
    type(input(root, 'Width in metres'), '1.6');
    blur(input(root, 'Width in metres'));
    assert.equal(readHostedElementSize(owner.ifcDataStore!, window, ownerView)?.OverallWidth, 1.6);
    assert.ok((s().undoStacks.get(MODEL_ID)?.length ?? 0) > originalDepth);
    assert.equal(s().undoStacks.get('decoy')?.length ?? 0, decoyDepth);
    assert.equal(remeshed.length, 1);
    assert.equal(remeshed[0].modelId, MODEL_ID, 'remeshing uses the selected entity owner');
    if (decoyView) assert.deepEqual(placedBodyExtent(models.get('decoy')!.ifcDataStore!, window, decoyView), decoyShape);
    act(() => s().undo(MODEL_ID));
    assert.equal(readHostedElementSize(owner.ifcDataStore!, window, ownerView)?.OverallWidth, 1.2);
    assert.equal(s().undoStacks.get(MODEL_ID)?.length, originalDepth, 'one undo restores the entire occurrence edit');
  });

  it('shows the host wall, the offset along it and the sill', () => {
    const root = render(<ModelInspectorPanel />);
    const headings = [...root.querySelectorAll('h3')].map((h) => h.textContent);
    assert.deepEqual(headings, ['Type', 'Dimensions', 'Hosting']);
    assert.equal(root.querySelector('[data-inspector-host]')?.textContent, `W1 · IfcWall #${wall}`);
    assert.equal(input(root, 'Offset').value, '2.00');
    assert.equal(input(root, 'Sill').value, '0.90');
    assert.equal(input(root, 'Width in metres').value, '1.20');
    assert.equal(input(root, 'Height in metres').value, '1.50');
  });

  it('Select host selects the wall', () => {
    const root = render(<ModelInspectorPanel />);
    act(() => click(root.querySelector('[data-inspector-select-host]')!));
    assert.equal(s().selectedEntityId, toGlobalIdFromModels(s().models, MODEL_ID, wall));
  });

  it('edits width and height through actual inputs, recuts the host and undoes the entire shape in one step (#6232)', () => {
    const root = render(<ModelInspectorPanel />);
    const dataStore = s().models.get(MODEL_ID)!.ifcDataStore!;
    const view = s().mutationViews.get(MODEL_ID)!;
    const read = readHostedFill(dataStore, window, view)!;
    const original = placedBodyExtent(dataStore, read.openingId, view)!;
    const depth = s().undoStacks.get(MODEL_ID)?.length ?? 0;
    for (const [label, text, axis, expected] of [
      ['Width in metres', '1,6', 0, 1.6],
      ['Height in metres', '1,8', 2, 1.8],
    ] as const) {
      const field = input(root, label);
      type(field, text);
      blur(field);
      const cut = placedBodyExtent(dataStore, read.openingId, view)!;
      assert.ok(Math.abs(cut.max[axis] - cut.min[axis] - expected) < 1e-6, 'the IFC cut matches the requested physical size');
      assert.ok(remeshed.at(-1)?.expressIds.includes(window) && remeshed.at(-1)?.expressIds.includes(wall));
      act(() => s().undo(MODEL_ID));
      assert.deepEqual(placedBodyExtent(dataStore, read.openingId, view), original);
      assert.equal(s().undoStacks.get(MODEL_ID)?.length ?? 0, depth, 'one undo removes the full mapping/attribute transaction');
      assert.deepEqual(readHostedElementSize(dataStore, window, view), { OverallWidth: 1.2, OverallHeight: 1.5 });
    }
  });

  it('refuses width/height and position changes that collide with another opening, writing no history (#6232)', () => {
    const added = s().addHostedFill(MODEL_ID, wall, { kind: 'window', params: { Offset: 3.5, Sill: 0.9, Width: 1, Height: 1.5 } });
    assert.ok('expressId' in added);
    const root = render(<ModelInspectorPanel />);
    const dataStore = s().models.get(MODEL_ID)!.ifcDataStore!;
    const view = s().mutationViews.get(MODEL_ID)!;
    const depth = s().undoStacks.get(MODEL_ID)?.length ?? 0;
    for (const [label, text] of [['Width in metres', '2.2'], ['Height in metres', '4'], ['Offset', '3.5']] as const) {
      const field = input(root, label);
      type(field, text);
      blur(field);
    }
    assert.deepEqual(readHostedElementSize(dataStore, window, view), { OverallWidth: 1.2, OverallHeight: 1.5 });
    assert.equal(hosted(window).offset, 2);
    assert.equal(s().undoStacks.get(MODEL_ID)?.length ?? 0, depth);
    assert.equal(remeshed.length, 0);
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

  // Review of #6476: an opening of another shape than the builder's (a file's, another tool's) was held to its Location alone.
  it('holds an opening of any profile to its real extent, not just its Location', () => {
    const view = s().mutationViews.get(MODEL_ID)!;
    const read = readHostedFill(s().models.get(MODEL_ID)!.ifcDataStore!, window, view)!;
    // Shift the cut's profile 0.3 m along the wall off its Location, as a file opening may be drawn.
    const deref = (v: unknown) => Number(String(v).slice(1));
    const at = (id: number) => view.getNewEntity(id)!.attributes;
    const shape = deref(at(read.openingId)[6]);
    const solid = deref((at(deref((at(shape)[2] as unknown[])[0]))[3] as unknown[])[0]);
    const profile = deref(at(solid)[0]);
    const origin = deref(at(deref(at(profile)[2]))[0]);
    s().setPositionalAttributesBatch(MODEL_ID, [{ entityId: origin, index: 0, value: [0.3, 0.75] }]);
    const root = render(<ModelInspectorPanel />);
    const offset = input(root, 'Offset');
    type(offset, '5.3');
    blur(offset);
    assert.deepEqual(hosted(window), { host: wall, offset: 2, sill: 0.9 }, 'its cut would end at 5.3 + 0.3 + 0.6 = 6.2 m, past the 6 m wall');
    const fits = input(root, 'Offset');
    type(fits, '5.1');
    blur(fits);
    assert.deepEqual(hosted(window), { host: wall, offset: 5.1, sill: 0.9 }, 'ending at 6.0 m it fits');
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
