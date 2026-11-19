/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9202: the session workplane's height, as the running command sees it. The
 * runtime keeps the plane it resolved at launch, so a height set after a
 * command started used to move the plan and the 3D outline but not the ghost
 * or the commit.
 */

import '@/test/setup-dom.js';
import { updateCommandGesture } from './runtime';
import type { SlabPlaceGesture } from './commands/slab-place-geometry';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, press, render } from '@/test/render.js';
import { CommandBarContent } from '@/components/viewer/tools/command/CommandHud';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { resolveSlabEditChain } from '@/lib/slab-edit';
import type { SnapResult } from '@/lib/snap/types';
import './builtin.js';
import { commandPointerDown, commandPointerMove, getCommandRuntime, writeCommandField } from './runtime.js';
import { launchSlabTool } from './keys-workspace.js';
import { setRequestRemesh } from './transaction.js';
import type { CommandContext, WorkplaneSpec } from './types.js';

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false, modifiers: { shift: false, alt: false } });
const click = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); });
const state = () => useViewerStore.getState();
const round = (v: number) => +v.toFixed(6);
const offset = (): number | null => {
  const plane = state().session?.workplane;
  return plane?.kind === 'storey' ? plane.offset : null;
};
const setHeight = (height: number) => act(() => { state().setWorkplane({ kind: 'storey', storeyId: state().session!.storeyId!, offset: height }); });

const SLAB_LIKE = new Set(['IFCSLAB', 'IFCROOF', 'IFCPLATE']);
function bodies(): { cls: string; bottom: number; top: number }[] {
  const s = state();
  const view = s.mutationViews.get(MODEL_ID)!;
  const dataStore = s.models.get(MODEL_ID)!.ifcDataStore!;
  return view.getNewEntities()
    .filter((e) => SLAB_LIKE.has(e.type.toUpperCase()) && !view.isDeleted(e.expressId))
    .map((e) => {
      const chain = resolveSlabEditChain(dataStore, view, s.storeEditors.get(MODEL_ID)!, e.expressId, 1)!;
      return { cls: e.type.toUpperCase(), bottom: round(chain.baseElevation!), top: round(chain.baseElevation! + chain.thickness) };
    });
}
function ghostHeights(): number[] {
  const { command, ctx, gesture } = getCommandRuntime();
  const [ghost] = command!.ghost!(gesture, ctx as CommandContext);
  const plane = (ctx as CommandContext).workplane!;
  const ys: number[] = [];
  for (let i = 1; i < ghost.positions.length; i += 3) ys.push(ghost.positions[i]);
  // Heights above the storey floor: the plane's own offset put back on.
  const lift = plane.spec.kind === 'storey' ? plane.spec.offset : 0;
  return [Math.min(...ys), Math.max(...ys)].map((y) => round(plane.renderToLocal([ghost.positions[0], y, ghost.positions[2]])[2] + lift));
}

let restoreRemesh: () => void = () => {};

beforeEach(async () => {
  await seedModelingSession();
  state().enterModelWorkspace();
  state().setAuthoringDefaults({ slabMode: 'rectangle', slabClass: 'slab' });
  state().setAuthoringDims('slab', { Thickness: 0.3 });
  state().setAuthoringDims('roof', { Thickness: 0.3 });
  restoreRemesh = setRequestRemesh(() => {});
});
afterEach(() => {
  restoreRemesh();
  state().exitModelWorkspace();
  cleanup();
});

describe('the workplane height reaches the running command (#9202)', () => {
  it('a height set after the command started moves the ghost and the commit', () => {
    state().startCommand('slab.place');
    setHeight(1.5);
    assert.equal((getCommandRuntime().ctx as CommandContext).workplane?.spec.kind, 'storey');
    click(0, 0);
    act(() => { commandPointerMove(at(2, 3)); });
    assert.deepEqual(ghostHeights(), [1.2, 1.5], 'a floor slab hangs from the raised plane');
    click(2, 3);
    assert.deepEqual(bodies(), [{ cls: 'IFCSLAB', bottom: 1.2, top: 1.5 }]);
  });

  it('a height change mid-outline keeps the corner already placed', () => {
    state().startCommand('slab.place');
    click(1, 1);
    const running = getCommandRuntime().command;
    setHeight(2);
    assert.equal(getCommandRuntime().command, running, 'the command is not restarted');
    assert.deepEqual(getCommandRuntime().gesture && (getCommandRuntime().gesture as { points: unknown }).points, [[1, 1]]);
    click(3, 2);
    assert.deepEqual(bodies(), [{ cls: 'IFCSLAB', bottom: 1.7, top: 2 }]);
  });

  it('a command\'s key step sees the moved plane too', () => {
    state().startCommand('column.place');
    const first = getCommandRuntime().ctx;
    setHeight(2);
    assert.notEqual(getCommandRuntime().ctx, first, 'the context was rebound');
    const spec = (getCommandRuntime().ctx as CommandContext).workplane?.spec as Extract<WorkplaneSpec, { kind: 'storey' }>;
    assert.equal(spec.offset, 2);
  });

  it('the Height field drives the same offset, and reads it back', () => {
    state().startCommand('slab.place');
    const fields = getCommandRuntime().command!.fields!;
    const index = fields.findIndex((f) => f.id === 'planeHeight');
    assert.ok(index >= 0, 'slab.place has a Height field');
    act(() => { writeCommandField(index, 2.4); });
    assert.equal(offset(), 2.4);
    const runtime = getCommandRuntime();
    assert.equal(fields[index].read(runtime.gesture, runtime.ctx as CommandContext), 2.4);
  });

  it('a storey change starts its plane back at the floor', () => {
    state().startCommand('slab.place');
    setHeight(2);
    act(() => { state().setSessionStorey(UPPER_STOREY); });
    assert.equal(offset(), 0);
    assert.equal((getCommandRuntime().ctx as CommandContext).workplane?.spec.kind, 'storey');
  });
});

describe('the Roof tool draws at the top of the walls (#9202)', () => {
  const wall = (height: number) => state().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: height });

  it('raises the plane to the top of the storey\'s walls, and the roof sits on it', () => {
    wall(2.7);
    wall(3.2);
    act(() => { launchSlabTool('roof'); });
    // Isolate the retained flat roof's elevation; roof-place covers pitched previews.
    act(() => { updateCommandGesture(value => { const g = value as SlabPlaceGesture; return { ...g, roof: { ...g.roof, preset: 'flat' } }; }); });
    assert.equal(state().session?.activeCommandId, 'slab.place');
    assert.equal(state().authoringDefaults.slabClass, 'roof');
    assert.equal(round(offset()!), 3.2, 'the highest wall top');
    click(0, 0);
    act(() => { commandPointerMove(at(4, 4)); });
    assert.deepEqual(ghostHeights(), [3.2, 3.5]);
    click(4, 4);
    assert.deepEqual(bodies(), [{ cls: 'IFCROOF', bottom: 3.2, top: 3.5 }]);
  });

  it('the bar names what is being drawn, following the class', () => {
    const ui = render(<CommandBarContent tier={0} />);
    act(() => { launchSlabTool('roof'); });
    assert.match(ui.textContent ?? '', /^Roof/);
    act(() => { state().setAuthoringDefaults({ slabClass: 'slab' }); });
    assert.match(ui.textContent ?? '', /^Slab/);
  });

  it('a wall top at zero replaces an unpinned nonzero plane (#9214 review)', () => {
    const added = state().addWall(MODEL_ID, STOREY, { Start: [0,0,-3], End: [4,0,-3], Thickness: .2, Height: 3 });
    assert.ok('expressId' in added);
    act(() => { state().setWorkplane({ kind: 'storey', storeyId: STOREY, offset: 2 }, { pinned: false }); });
    act(() => { launchSlabTool('roof'); });
    assert.equal(offset(), 0, 'zero is the actual wall top, not an absent height');
    assert.equal(((getCommandRuntime().ctx as CommandContext).workplane?.spec as { offset: number }).offset, 0);
  });

  it('with no walls it takes the spacing to the storey above', () => {
    act(() => { launchSlabTool('roof'); });
    assert.equal(round(offset()!), 3, 'the fixture\'s upper storey is 3 m up');
  });

  it('on the top storey with no walls it takes the default wall height', () => {
    state().exitModelWorkspace();
    state().enterModelWorkspace({ storeyId: UPPER_STOREY });
    state().setAuthoringDims('wall', { Height: 2.9 });
    act(() => { launchSlabTool('roof'); });
    assert.equal(round(offset()!), 2.9);
  });

  it('the plane comes back down when the roof drawing ends, however it ends', () => {
    wall(3);
    act(() => { launchSlabTool('roof'); });
    assert.equal(round(offset()!), 3);
    press(document.body, 'Escape');
    assert.equal(state().session?.activeCommandId, null);
    assert.equal(offset(), 0, 'Escape');

    act(() => { launchSlabTool('roof'); });
    act(() => { state().startCommand('wall.place'); });
    assert.equal(offset(), 0, 'another tool draws at the floor');
    assert.equal((getCommandRuntime().ctx as CommandContext).workplane?.spec.kind, 'storey');
    assert.equal(((getCommandRuntime().ctx as CommandContext).workplane?.spec as { offset: number }).offset, 0, 'and its command got that plane');

    act(() => { launchSlabTool('roof'); });
    act(() => { launchSlabTool('slab'); });
    assert.equal(state().authoringDefaults.slabClass, 'slab', 'the Slab entry leaves the roof class');
    assert.equal(offset(), 0, 'the Slab tool');
  });

  it('the bar\'s Roof segment takes the same path as the rail', () => {
    wall(3);
    state().startCommand('slab.place');
    assert.equal(offset(), 0);
    act(() => { state().setAuthoringDefaults({ slabClass: 'roof' }); });
    assert.equal(round(offset()!), 3);
    act(() => { state().setAuthoringDefaults({ slabClass: 'plate' }); });
    assert.equal(offset(), 0);
  });

  it('a height the user chose stays: before the tool, and while it runs', () => {
    wall(3);
    setHeight(5);
    act(() => { launchSlabTool('roof'); });
    assert.equal(offset(), 5, 'an already raised plane is not overridden');
    press(document.body, 'Escape');
    assert.equal(offset(), 5, 'nor lowered when the tool ends');

    act(() => { state().setWorkplane({ kind: 'storey', storeyId: STOREY, offset: 0 }, { pinned: false }); });
    act(() => { launchSlabTool('roof'); });
    assert.equal(round(offset()!), 3);
    setHeight(4);
    press(document.body, 'Escape');
    assert.equal(offset(), 4, 'a height typed during the roof is the user\'s');
  });

  // Review of #9214: 0 chosen on purpose is a height too.
  it('a height typed as 0 is pinned, and Floor hands it back', () => {
    wall(3);
    setHeight(0);
    act(() => { launchSlabTool('roof'); });
    assert.equal(offset(), 0, 'a typed 0 is the user\'s');
    press(document.body, 'Escape');
    act(() => { state().setWorkplane({ kind: 'storey', storeyId: STOREY, offset: 0 }, { pinned: false }); });
    act(() => { launchSlabTool('roof'); });
    assert.equal(round(offset()!), 3, 'after Floor the Roof tool raises it again');
  });

  it('a storey change while drawing a roof raises to the new storey\'s walls', () => {
    state().addWall(MODEL_ID, UPPER_STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 2.5 });
    wall(3);
    act(() => { launchSlabTool('roof'); });
    assert.equal(round(offset()!), 3);
    act(() => { state().setSessionStorey(UPPER_STOREY); });
    assert.equal(round(offset()!), 2.5);
    press(document.body, 'Escape');
    assert.equal(offset(), 0);
  });
});
