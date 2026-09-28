/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer must be able to split an element it has just authored (#6233).
 *
 * Reproduced on the demo project (a MILLIMETRE file): Author → Wall, then
 * Split → click the wall → "Couldn't split: not a splittable element". The
 * in-store builders take metres and write the file's native unit
 * (`toNativePoint3` / `toNativeLength`), but the wall and linear-element
 * chain readers handed those native millimetres straight to a Split tool
 * whose cursor, handles and builders all work in metres — so the hover
 * projection clamped to the wall's start (distance 0, no cut), and the slab
 * reader skipped its unit scale for overlay entities on the stale belief
 * that authored geometry is stored in metres.
 *
 * Every element here is authored through the same slice actions the Add
 * Element tool calls (`addWall` / `addBeam` / … → `runInStoreElementBuilder`
 * → `@ifc-lite/create` in-store builders), aimed at with a metre cursor the
 * way `handleSplitHover` does, and split through the same actions the click
 * commits. Both a metre and a millimetre file run, because the millimetre
 * one is the regression and the metre one is where the defect hid.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import type { IfcAttributeValue } from '@ifc-lite/mutations';
import { asCoordinateTriple, asExpressIdRef, readAttributes, resolvePlacementChain } from '@/lib/placement-core';
import { HUNG_SLAB, MESH_WALL, MODEL_ID, ROTATED_BEAM, STOREY, TILTED_SLAB, seedModelingSession } from '@/test/modeling-session-fixture';
import { resolveSlabEditChain } from '@/lib/slab-edit';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';

function created(result: { expressId: number } | { error: string }): number {
  assert.ok('expressId' in result, `builder failed: ${'error' in result ? result.error : ''}`);
  return result.expressId;
}

function near(actual: readonly number[], expected: readonly number[], what: string): void {
  assert.equal(actual.length, expected.length, what);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-6, `${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`));
}

function polygonArea(points: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  points.forEach(([x1, y1], i) => {
    const [x2, y2] = points[(i + 1) % points.length];
    a += x1 * y2 - x2 * y1;
  });
  return Math.abs(a / 2);
}

for (const unit of ['metre', 'millimetre'] as const) {
  describe(`splitting in-store-authored elements in a ${unit} file (#6233)`, () => {
    beforeEach(() => seedModelingSession({ unit }));

    it('an authored wall splits where the metre cursor points', () => {
      const s = useViewerStore.getState();
      const wall = created(s.addWall(MODEL_ID, STOREY, { Start: [1, 2, 0], End: [6, 2, 0], Thickness: 0.25, Height: 2.8 }));
      assert.deepEqual(s.readSplitTarget(MODEL_ID, wall), { ok: true, kind: 'wall' });

      // The hover projects the cursor (metres, like `rendererPointToIfcStoreyLocal`).
      const hover = s.readWallSplitProjection(MODEL_ID, wall, [3, 2.3, 0]);
      assert.ok(hover);
      assert.ok(Math.abs(hover.distance - 2) < 1e-9, `cut distance ${hover.distance}, want 2 m`);
      assert.ok(Math.abs(hover.length - 5) < 1e-9, `wall length ${hover.length}, want 5 m`);

      const split = useViewerStore.getState().splitWallAtDistance(MODEL_ID, wall, hover.distance);
      assert.ok(split.ok, split.ok ? '' : split.reason);
      if (!split.ok) return;
      const left = useViewerStore.getState().readWallEndpoints(MODEL_ID, split.left.expressId);
      const right = useViewerStore.getState().readWallEndpoints(MODEL_ID, split.right.expressId);
      assert.ok(left && right);
      near(left.start, [1, 2, 0], 'left start');
      near(left.end, [3, 2, 0], 'left end');
      near(right.start, [3, 2, 0], 'right start');
      near(right.end, [6, 2, 0], 'right end');
      near([left.thickness, right.thickness], [0.25, 0.25], 'thickness survives the split');

      // A half is itself splittable, at the same metre scale.
      const again = useViewerStore.getState().readWallSplitProjection(MODEL_ID, split.right.expressId, [4.5, 2, 0]);
      assert.ok(again && Math.abs(again.distance - 1.5) < 1e-9, `re-split distance ${again?.distance}, want 1.5 m`);
    });

    for (const kind of ['beam', 'member'] as const) {
      it(`an authored ${kind} splits along its axis and is not mistaken for a wall`, () => {
        const s = useViewerStore.getState();
        const params = { Start: [0, 0, 3] as [number, number, number], End: [4, 0, 3] as [number, number, number], Width: 0.2, Height: 0.3 };
        const id = created(kind === 'beam' ? s.addBeam(MODEL_ID, STOREY, params) : s.addMember(MODEL_ID, STOREY, params));
        assert.deepEqual(s.readSplitTarget(MODEL_ID, id), { ok: true, kind: 'linear' });
        // Same rectangle profile + explicit RefDirection as a wall: the wall
        // reader used to accept it and offer wall endpoints / a wall split.
        assert.equal(s.readWallEndpoints(MODEL_ID, id), null);
        assert.equal(s.readWallSplitProjection(MODEL_ID, id, [1.5, 0, 3]), null);

        const hover = s.readLinearElementSplitProjection(MODEL_ID, id, [1.5, 0.1, 3]);
        assert.ok(hover && Math.abs(hover.distance - 1.5) < 1e-9, `cut distance ${hover?.distance}, want 1.5 m`);
        const split = useViewerStore.getState().splitLinearElementAtDistance(MODEL_ID, id, hover.distance);
        assert.ok(split.ok, split.ok ? '' : split.reason);
        if (!split.ok) return;
        const source = useViewerStore.getState().readLinearElementSplitProjection(MODEL_ID, id, [0, 0, 3]);
        const rest = useViewerStore.getState().readLinearElementSplitProjection(MODEL_ID, split.right.expressId, [1.5, 0, 3]);
        assert.ok(source && rest);
        near([source.length, rest.length], [1.5, 2.5], 'source shrinks to the cut, the new piece takes the rest');
        near(rest.cutPoint, [1.5, 0, 3], 'new piece starts at the cut');
      });
    }

    it('an authored column splits at the cursor height', () => {
      const s = useViewerStore.getState();
      const id = created(s.addColumn(MODEL_ID, STOREY, { Position: [2, 2, 0], Width: 0.3, Depth: 0.3, Height: 3 }));
      assert.deepEqual(s.readSplitTarget(MODEL_ID, id), { ok: true, kind: 'linear' });
      const hover = s.readLinearElementSplitProjection(MODEL_ID, id, [2.1, 2, 1.2]);
      assert.ok(hover && Math.abs(hover.distance - 1.2) < 1e-9, `cut distance ${hover?.distance}, want 1.2 m`);
      const split = useViewerStore.getState().splitLinearElementAtDistance(MODEL_ID, id, hover.distance);
      assert.ok(split.ok, split.ok ? '' : split.reason);
      if (!split.ok) return;
      const source = useViewerStore.getState().readLinearElementSplitProjection(MODEL_ID, id, [2, 2, 0]);
      const rest = useViewerStore.getState().readLinearElementSplitProjection(MODEL_ID, split.right.expressId, [2, 2, 1.2]);
      assert.ok(source && rest);
      near([source.length, rest.length], [1.2, 1.8], 'column lengths after the cut');
    });

    for (const kind of ['slab', 'roof', 'plate'] as const) {
      it(`an authored ${kind} splits along a metre cut line`, () => {
        const s = useViewerStore.getState();
        const params = { Position: [0, 0, 0] as [number, number, number], Width: 4, Depth: 3, Thickness: 0.2 };
        const id = created(kind === 'slab' ? s.addSlab(MODEL_ID, STOREY, params)
          : kind === 'roof' ? s.addRoof(MODEL_ID, STOREY, params) : s.addPlate(MODEL_ID, STOREY, params));
        assert.deepEqual(s.readSplitTarget(MODEL_ID, id), { ok: true, kind: 'slab' });
        const fp = s.readSlabFootprint(MODEL_ID, id);
        assert.ok(fp);
        assert.ok(Math.abs(polygonArea(fp.footprint) - 12) < 1e-6, `footprint area ${polygonArea(fp.footprint)}, want 12 m²`);
        assert.ok(Math.abs(fp.thickness - 0.2) < 1e-9, `thickness ${fp.thickness}, want 0.2 m`);

        const split = useViewerStore.getState().splitSlabByLine(MODEL_ID, id, [1, -1], [1, 4]);
        assert.ok(split.ok, split.ok ? '' : split.reason);
        if (!split.ok) return;
        const areas = [split.left, split.right]
          .map((half) => useViewerStore.getState().readSlabFootprint(MODEL_ID, half.expressId))
          .map((half) => (half ? polygonArea(half.footprint) : NaN))
          .sort((a, b) => a - b);
        near(areas, [3, 9], 'halves of a 4 × 3 m slab cut at x = 1 m');
      });
    }

    it('a hosted opening past the cut moves to the far piece at its native-unit offset', () => {
      const s = useViewerStore.getState();
      const wall = created(s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.25, Height: 2.8 }));
      const view = useViewerStore.getState().mutationViews.get(MODEL_ID);
      const editor = useViewerStore.getState().storeEditors.get(MODEL_ID);
      const dataStore = useViewerStore.getState().models.get(MODEL_ID)?.ifcDataStore;
      assert.ok(view && editor && dataStore);
      const wallPlacement = resolvePlacementChain(dataStore, view, editor, wall)?.localPlacementId;
      assert.ok(wallPlacement !== undefined);
      // An opening 3 m along the wall, in the file's own unit.
      const native = unit === 'metre' ? 1 : 1000;
      const add = (type: string, attrs: IfcAttributeValue[]) => editor.addEntity(type, attrs).expressId;
      const point = add('IfcCartesianPoint', [[3 * native, 0, 0]]);
      const axis = add('IfcAxis2Placement3D', [`#${point}`, null, null]);
      const placement = add('IfcLocalPlacement', [`#${wallPlacement}`, `#${axis}`]);
      const opening = add('IfcOpeningElement', ['0pening000000000000001', null, 'o', null, null, `#${placement}`, null, null]);
      const rel = add('IfcRelVoidsElement', ['0penRel00000000000001', null, null, null, `#${wall}`, `#${opening}`]);

      const split = useViewerStore.getState().splitWallAtDistance(MODEL_ID, wall, 2);
      assert.ok(split.ok, split.ok ? '' : split.reason);
      if (!split.ok) return;
      assert.deepEqual(split.openings, { toLeft: 0, toRight: 1, skipped: 0 });
      assert.equal(asExpressIdRef(readAttributes(dataStore, view, editor, rel)?.[4]), split.right.expressId);
      near(asCoordinateTriple(readAttributes(dataStore, view, editor, point)?.[0]) ?? [], [1 * native, 0, 0],
        'the opening keeps its place: 1 m into the far piece');
    });

    it('an imported beam extruded along a rotated solid position is refused, not cut along the wrong axis', () => {
      // AC20's `Unterzug-1` shape: the reader used to take the placement's
      // +Z for its axis, so Split offered to cut a horizontal beam vertically.
      const target = useViewerStore.getState().readSplitTarget(MODEL_ID, ROTATED_BEAM);
      assert.deepEqual(target, { ok: false, reasonKey: 'splitTool.unavailable.shape' });
      assert.equal(useViewerStore.getState().readLinearElementSplitProjection(MODEL_ID, ROTATED_BEAM, [0, 0, 0]), null);
    });

    it('an imported slab keeps its height when split; a tilted one is refused', () => {
      // AC20's roof slabs extrude along a tilted axis: cutting their plan
      // outline would re-author them as flat slabs.
      assert.deepEqual(useViewerStore.getState().readSplitTarget(MODEL_ID, TILTED_SLAB), { ok: false, reasonKey: 'splitTool.unavailable.shape' });

      // Placement at z = 0.5 m, solid 0.2 m below it: the slab spans 0.3 … 0.5 m.
      assert.deepEqual(useViewerStore.getState().readSplitTarget(MODEL_ID, HUNG_SLAB), { ok: true, kind: 'slab' });
      const split = useViewerStore.getState().splitSlabByLine(MODEL_ID, HUNG_SLAB, [1, -1], [1, 4]);
      assert.ok(split.ok, split.ok ? '' : split.reason);
      if (!split.ok) return;
      const s = useViewerStore.getState();
      const dataStore = s.models.get(MODEL_ID)!.ifcDataStore!;
      const bases = [split.left, split.right].map((half) => {
        const chain = resolveSlabEditChain(dataStore, s.mutationViews.get(MODEL_ID)!, s.storeEditors.get(MODEL_ID)!, half.expressId, getModelLengthUnitScale(dataStore));
        return chain?.baseElevation != null ? Math.round(chain.baseElevation * 1e6) / 1e6 : null;
      });
      assert.deepEqual(bases, [0.3, 0.3], 'both pieces start where the source did');
    });

    it('the Split button and the commit read the same live containment', () => {
      // The commit resolves the storey through queued containment edits
      // (#6351); the button's predicate read the load-time index, so a wall
      // whose containment was removed offered Split and then failed on click.
      const wall = created(useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 2.5 }));
      const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
      const containment = view.getNewEntities().find((e) => e.type === 'IfcRelContainedInSpatialStructure'
        && Array.isArray(e.attributes[4]) && e.attributes[4].includes(`#${wall}`));
      assert.ok(containment);
      view.deleteEntity(containment.expressId);

      assert.deepEqual(useViewerStore.getState().readSplitTarget(MODEL_ID, wall), { ok: false, reasonKey: 'splitTool.unavailable.storey' });
      assert.equal(useViewerStore.getState().splitWallAtDistance(MODEL_ID, wall, 2).ok, false);
    });

    it('an imported mesh-bodied wall is refused with the reason the Split button shows', () => {
      const target = useViewerStore.getState().readSplitTarget(MODEL_ID, MESH_WALL);
      assert.deepEqual(target, { ok: false, reasonKey: 'splitTool.unavailable.mesh' });
      const commit = useViewerStore.getState().splitWallAtDistance(MODEL_ID, MESH_WALL, 0.5);
      assert.equal(commit.ok, false);
      assert.match(commit.ok ? '' : commit.reason, /mesh or B-rep/);
    });
  });
}
