/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import './builtin';
import { commandPointerDown, getCommandRuntime } from './runtime';
import { copySelectionToClipboard, clearCopyClipboard } from './copy-clipboard';
import { toGlobalIdFromModels } from '@/store/globalId';
import { NO_MODIFIERS, solveCommandSnap } from './snap-solve';
import type { SnapProfile, SnapSource, Vec2 } from '@/lib/snap/types';

// A host must survive even when a view-specific profile ranks grid above face.
const gridFirst: SnapProfile = { radiusPx: 12, tiers: [['grid'], ['face']], sources: ['grid', 'mesh'] };

beforeEach(async () => { await seedModelingSession(); });
afterEach(() => { clearCopyClipboard(); useViewerStore.getState().exitModelWorkspace(); });

for (const id of ['door.place', 'window.place', 'opening.place']) {
  it(`#9296 ${id} retains its host face and never snaps to a world increment`, () => {
    const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, {
      Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3,
    });
    assert.ok('expressId' in wall);
    useViewerStore.getState().startCommand(id);
    const runtime = getCommandRuntime();
    assert.equal(runtime.command?.id, id);
    const cursor: Vec2 = [1.237, 0.1];
    const entity = { modelId: MODEL_ID, expressId: wall.expressId };
    const face: SnapSource = {
      id: 'mesh',
      collect(_query, _radius, out) { out.push({ kind: 'face', source: 'mesh', local: cursor, entity }); },
    };
    // Both views share this entry point; omitted aim also defaults to snapping.
    for (const profile of [gridFirst, undefined]) for (const aim of ['snap', undefined] as const) {
      const input = { cursor, metresPerPixel: 0.01, mods: NO_MODIFIERS, aim, profile };
      const onHost = solveCommandSnap(runtime, runtime.ctx!.workplane!, { ...input, sources: [face] });
      assert.equal(onHost?.winner?.kind, 'face', 'preserve the aimed wall instead of quantising off it');
      assert.deepEqual(onHost?.winner?.entity, entity);
      assert.deepEqual(onHost?.local, cursor);
      const noHost = solveCommandSnap(runtime, runtime.ctx!.workplane!, { ...input, sources: [] });
      assert.equal(noHost?.winner, null, 'empty space cannot manufacture a host-less grid winner');
      assert.deepEqual(noHost?.local, cursor);
    }
  });
}

for (const id of ['wall.place', 'slab.place', 'column.place', 'beam.place', 'grid.place']) {
  it(`#9296 ${id} still snaps free placement points to the increment`, () => {
    useViewerStore.getState().startCommand(id);
    const runtime = getCommandRuntime();
    assert.equal(runtime.command?.id, id);
    const snap = solveCommandSnap(runtime, runtime.ctx!.workplane!, {
      cursor: [1.237, 2.347], metresPerPixel: 0.01, sources: [], mods: NO_MODIFIERS, aim: 'snap',
    });
    assert.equal(snap?.winner?.source, 'grid');
    assert.equal(snap?.winner?.increment, 0.1);
    assert.deepEqual(snap?.local.map((n) => +n.toFixed(3)), [1.2, 2.3]);
  });
}

for (const id of ['element.move', 'element.paste']) {
  it(`#9296 ${id} keeps the increment at its free-point target`, () => {
    const s = useViewerStore.getState();
    const column = s.addColumn(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });
    assert.ok('expressId' in column);
    s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, column.expressId));
    if (id === 'element.paste') assert.equal(copySelectionToClipboard(useViewerStore.getState(), MODEL_ID).ok, true);
    s.startCommand(id);
    if (id === 'element.move') commandPointerDown({ local: [0, 0], winner: null, guides: [], locked: false });
    const runtime = getCommandRuntime();
    assert.equal(runtime.command?.id, id);
    const snap = solveCommandSnap(runtime, runtime.ctx!.workplane!, {
      cursor: [1.237, 2.347], metresPerPixel: 0.01, sources: [], mods: NO_MODIFIERS, aim: 'snap',
    });
    assert.equal(snap?.winner?.source, 'grid');
    assert.equal(snap?.winner?.increment, 0.1);
    assert.deepEqual(snap?.local.map((n) => +n.toFixed(3)), [1.2, 2.3]);
  });
}
