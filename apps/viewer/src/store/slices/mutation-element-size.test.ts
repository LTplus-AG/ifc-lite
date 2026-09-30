/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One element's size, written one way (#6232 C4): a slab's thickness, a
 * column's or beam's length and section, and a wall's thickness and height
 * with the openings it hosts. Each edit is ONE undo step and a refused edit
 * writes nothing. A wall thickened past its openings' cuts lengthens them so
 * the door or window still opens through it; a wall lowered below an opening
 * is refused; a slab's openings follow its thickness.
 */

import '@/lib/placement-edit.boot';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { placedBodyExtent, readHostedFill, resolveHostAnchor } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { resolveLinearElementChain } from '@/lib/linear-element-edit';
import { resolveSlabEditChain } from '@/lib/slab-edit';
import { readElementSize, setElementSize } from './mutation-element-size.js';

const s = () => useViewerStore.getState();
const undoDepth = () => s().undoStacks.get(MODEL_ID)?.length ?? 0;
const get = useViewerStore;
const live = () => ({ dataStore: s().models.get(MODEL_ID)!.ifcDataStore!, view: s().mutationViews.get(MODEL_ID)! });
const id = (made: { expressId: number } | { error: string }): number => {
  assert.ok('expressId' in made, 'error' in made ? made.error : '');
  return made.expressId;
};
const close = (a: number, b: number, message: string) => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} vs ${b}`);

/** The wall body's and its opening's cut extents across the wall, native units (the fixture is metres). */
function acrossWall(wall: number, opening: number): { body: [number, number]; cut: [number, number] } {
  const { dataStore, view } = live();
  const body = resolveHostAnchor(dataStore, wall, view).hostBounds!;
  const cut = placedBodyExtent(dataStore, opening, view)!;
  return { body: [body.min[1], body.max[1]], cut: [cut.min[1], cut.max[1]] };
}

beforeEach(async () => { await seedModelingSession(); });
afterEach(() => { s().exitModelWorkspace(); });

describe('setElementSize (#6232 C4)', () => {
  it('a slab thickness is one undo step, and the read reports it back', () => {
    const slab = id(s().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 }));
    const before = undoDepth();
    const outcome = setElementSize(get, MODEL_ID, slab, { kind: 'slab', thickness: 0.35 });
    assert.deepEqual(outcome, { ok: true, remesh: [slab] });
    close((readElementSize(s(), MODEL_ID, slab) as { thickness: number }).thickness, 0.35, 'thickness after');
    assert.equal(undoDepth() - before, 1, 'one positional write');
    s().undo(MODEL_ID);
    close((readElementSize(s(), MODEL_ID, slab) as { thickness: number }).thickness, 0.2, 'thickness after undo');
  });

  it('a column keeps its base when its length changes; a beam edits length, width and cross-section', () => {
    const column = id(s().addColumn(MODEL_ID, STOREY, { Position: [2, 2, 0], Width: 0.3, Depth: 0.4, Height: 3 }));
    assert.equal(setElementSize(get, MODEL_ID, column, { kind: 'linear', length: 4.5 }).ok, true);
    assert.deepEqual(readElementSize(s(), MODEL_ID, column), { kind: 'linear', length: 4.5, width: 0.3, cross: 0.4 });
    assert.deepEqual(s().readEntityPosition(MODEL_ID, column), [2, 2, 0], 'the base stays');

    const beam = id(s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [4, 0, 3], Width: 0.2, Height: 0.3 }));
    const before = undoDepth();
    assert.equal(setElementSize(get, MODEL_ID, beam, { kind: 'linear', length: 5, width: 0.25, cross: 0.5 }).ok, true);
    assert.deepEqual(readElementSize(s(), MODEL_ID, beam), { kind: 'linear', length: 5, width: 0.25, cross: 0.5 });
    assert.equal(undoDepth() - before, 3, 'three positional writes, one per slot');
  });

  it('a column pulled by its start face keeps the far end where it was', () => {
    const column = id(s().addColumn(MODEL_ID, STOREY, { Position: [0, 0, 1], Width: 0.3, Depth: 0.3, Height: 2 }));
    assert.equal(setElementSize(get, MODEL_ID, column, { kind: 'linear', length: 3, fixed: 'end' }).ok, true);
    const [, , z] = s().readEntityPosition(MODEL_ID, column)!;
    close(z, 0, 'the start moved down by the metre it grew');
    const size = readElementSize(s(), MODEL_ID, column);
    assert.ok(size?.kind === 'linear');
    close(z + size.length, 3, 'the end stayed at 3 m');
  });

  it('refuses a size that is not a positive number, writing nothing', () => {
    const column = id(s().addColumn(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 }));
    const before = undoDepth();
    for (const length of [0, -1, Number.NaN]) {
      assert.equal(setElementSize(get, MODEL_ID, column, { kind: 'linear', length }).ok, false);
    }
    assert.equal(undoDepth(), before);
  });

  describe('a wall keeps its openings valid (#6232 C4)', () => {
    let wall = 0;
    let opening = 0;
    let window = 0;
    beforeEach(() => {
      wall = id(s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [6, 0, 0], Thickness: 0.2, Height: 3 }));
      const placed = s().addHostedFill(MODEL_ID, wall, { kind: 'window', params: { Offset: 2, Sill: 0.9, Width: 1, Height: 1.2 } });
      assert.ok('expressId' in placed, 'error' in placed ? placed.error : '');
      window = placed.expressId;
      opening = placed.openingId;
    });

    it('a thicker wall lengthens the cut so the window still opens through it, in one undo step', () => {
      const { body, cut } = acrossWall(wall, opening);
      assert.ok(cut[0] <= body[0] && cut[1] >= body[1], 'the cut spans the wall as built');
      const before = undoDepth();
      const depthBefore = cut[1] - cut[0];

      const outcome = setElementSize(get, MODEL_ID, wall, { kind: 'wall', thickness: 0.6 });
      assert.ok(outcome.ok);
      assert.deepEqual([...outcome.remesh].sort(), [wall, opening].sort(), 'the re-cut opening re-meshes with the wall');
      const after = acrossWall(wall, opening);
      close(after.body[1] - after.body[0], 0.6, 'wall thickness');
      assert.ok(after.cut[0] <= after.body[0] + 1e-9 && after.cut[1] >= after.body[1] - 1e-9, `the cut ${after.cut} spans the new body ${after.body}`);
      assert.ok(after.cut[1] - after.cut[0] > depthBefore, 'the cut got longer');
      assert.equal(readWindowOffset(window), 2, 'the window did not move along the wall');
      const tags = new Set(s().undoStacks.get(MODEL_ID)!.slice(before).map((m) => s().mutationBatchTags.get(m.id)));
      assert.equal(tags.size, 1, 'one batch');

      s().undo(MODEL_ID);
      const undone = acrossWall(wall, opening);
      close(undone.cut[1] - undone.cut[0], depthBefore, 'one undo restores the cut');
      close(undone.body[1] - undone.body[0], 0.2, 'and the wall');
    });

    it('a thinner wall leaves the cut alone', () => {
      const { cut } = acrossWall(wall, opening);
      const outcome = setElementSize(get, MODEL_ID, wall, { kind: 'wall', thickness: 0.1 });
      assert.deepEqual(outcome, { ok: true, remesh: [wall] });
      assert.deepEqual(acrossWall(wall, opening).cut, cut);
    });

    it('a height that would leave the window above the wall is refused, writing nothing', () => {
      const before = undoDepth();
      const outcome = setElementSize(get, MODEL_ID, wall, { kind: 'wall', height: 1.5 });
      assert.equal(outcome.ok, false);
      assert.match(outcome.ok ? '' : outcome.reason, /reaches above the new top/);
      assert.equal(undoDepth(), before);
      assert.equal(s().readWallEndpoints(MODEL_ID, wall)?.height, 3);
    });

    it('a taller wall, and a lower one that still clears the window, are written', () => {
      assert.equal(setElementSize(get, MODEL_ID, wall, { kind: 'wall', height: 4 }).ok, true);
      assert.equal(s().readWallEndpoints(MODEL_ID, wall)?.height, 4);
      assert.equal(setElementSize(get, MODEL_ID, wall, { kind: 'wall', height: 2.4 }).ok, true);
      assert.equal(s().readWallEndpoints(MODEL_ID, wall)?.height, 2.4);
    });

    function readWindowOffset(fill: number): number {
      const target = live();
      return readHostedFill(target.dataStore, fill, target.view)!.offset;
    }
  });

  it("a slab's opening follows its thickness", () => {
    const slab = id(s().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 6, Depth: 6, Thickness: 0.2 }));
    const made = s().addHostedFill(MODEL_ID, slab, { kind: 'opening', params: { Position: [3, 3], Width: 1, Depth: 1 } });
    assert.ok('expressId' in made, 'error' in made ? made.error : '');
    const { dataStore, view } = live();
    const spans = () => {
      const body = resolveHostAnchor(dataStore, slab, view).hostBounds!;
      const cut = placedBodyExtent(dataStore, made.openingId, view)!;
      return cut.min[2] <= body.min[2] + 1e-9 && cut.max[2] >= body.max[2] - 1e-9;
    };
    assert.equal(spans(), true, 'the cut spans the slab as built');
    assert.equal(setElementSize(get, MODEL_ID, slab, { kind: 'slab', thickness: 0.5 }).ok, true);
    assert.equal(spans(), true, 'and the thicker slab');
    s().undo(MODEL_ID);
    assert.equal(spans(), true);
    close((readElementSize(s(), MODEL_ID, slab) as { thickness: number }).thickness, 0.2, 'one undo restores the thickness');
  });
});

describe('sizes in a millimetre file (#6232 C4)', () => {
  beforeEach(async () => { await seedModelingSession({ unit: 'millimetre', storeyOffset: [3, 3] }); });

  it('writes the file\'s unit: a 0.35 m slab is 350, a 5 m column 5000, and the openings follow in millimetres', () => {
    const slab = id(s().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 }));
    assert.equal(setElementSize(get, MODEL_ID, slab, { kind: 'slab', thickness: 0.35 }).ok, true);
    const written = (entity: number, index: number) => s().mutationViews.get(MODEL_ID)!.getPositionalMutationsForEntity(entity)?.get(index);
    const solid = readSolidId(slab);
    assert.equal(written(solid, 3), 350, 'the depth is in millimetres');
    close((readElementSize(s(), MODEL_ID, slab) as { thickness: number }).thickness, 0.35, 'and reads back in metres');

    const column = id(s().addColumn(MODEL_ID, STOREY, { Position: [2, 2, 0], Width: 0.3, Depth: 0.3, Height: 3 }));
    assert.equal(setElementSize(get, MODEL_ID, column, { kind: 'linear', length: 5 }).ok, true);
    assert.equal(written(readSolidId(column), 3), 5000);

    const wall = id(s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [6, 0, 0], Thickness: 0.2, Height: 3 }));
    const placed = s().addHostedFill(MODEL_ID, wall, { kind: 'window', params: { Offset: 2, Sill: 0.9, Width: 1, Height: 1.2 } });
    assert.ok('expressId' in placed);
    assert.equal(setElementSize(get, MODEL_ID, wall, { kind: 'wall', thickness: 0.6 }).ok, true);
    const { body, cut } = acrossWall(wall, placed.openingId);
    close(body[1] - body[0], 600, 'the wall is 600 mm');
    assert.ok(cut[0] <= body[0] + 1e-6 && cut[1] >= body[1] - 1e-6, `the cut ${cut} spans the body ${body} in millimetres`);
    assert.equal(setElementSize(get, MODEL_ID, wall, { kind: 'wall', height: 2 }).ok, false, 'a 2 m wall would leave the window (top at 2.1 m) above it');
  });

  /** The IfcExtrudedAreaSolid the size writers edit, by the same chain readers they use. */
  function readSolidId(expressId: number): number {
    const { dataStore, view } = live();
    const editor = s().storeEditors.get(MODEL_ID)!;
    const chain = resolveSlabEditChain(dataStore, view, editor, expressId, 0.001) ?? resolveLinearElementChain(dataStore, view, editor, expressId, 0.001);
    assert.ok(chain, `#${expressId} has an extruded solid`);
    return chain.extrudedSolidId;
  }
});
