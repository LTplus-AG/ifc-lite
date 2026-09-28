/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one plan-cut path (charter #6232 M2.4): the storey plan's frame maps a
 * cut point to the same workplane-local point the workplane itself does
 * (whatever the plane offset), the cut runs through the real
 * `Drawing2DGenerator`, and Space Sketch's construction underlay, now a thin
 * frame over the same hook, still lands in the room frame (ifcX, ifcY).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { resolveWorkplane } from '@/lib/commands/modeling/registry';
import type { Workplane } from '@/lib/commands/modeling/types';
import { useConstructionUnderlay, type UnderlayLine } from '@/hooks/useConstructionUnderlay';
import { PLAN_CUT_DEBOUNCE_MS, PLAN_CUT_HEIGHT, mapPlanDrawing, modelPlacementOf, planCutFrame } from './usePlanCut';

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, PLAN_CUT_DEBOUNCE_MS + 250)));

/** An axis-aligned box in render space (Y up), as 12 triangles. */
function box(expressId: number, min: [number, number, number], max: [number, number, number]): MeshData {
  const c = (i: number): [number, number, number] => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const positions = new Float32Array(Array.from({ length: 8 }, (_, i) => c(i)).flat());
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const indices = new Uint32Array(quads.flatMap(([a, b, cc, d]) => [a, b, cc, a, cc, d]));
  return { expressId, positions, normals: new Float32Array(positions.length), indices, color: [1, 1, 1, 1], ifcType: 'IfcWall' } as MeshData;
}

function storeyPlane(offset: number): Workplane {
  const plane = resolveWorkplane(useViewerStore.getState(), MODEL_ID, { kind: 'storey', storeyId: STOREY, offset });
  assert.ok(!('refused' in plane));
  return plane;
}

beforeEach(async () => { await seedModelingSession(); });
afterEach(() => cleanup());

describe('planCutFrame', () => {
  it('cuts 1.2 m above the storey floor and maps a cut point to its workplane-local point, at any offset', () => {
    for (const offset of [0, 0.75]) {
      const plane = storeyPlane(offset);
      const { cutY, map } = planCutFrame(plane, modelPlacementOf(useViewerStore.getState().modelPlacement, MODEL_ID), offset);
      const floor = storeyPlane(0).localToRender([0, 0, 0])[1];
      assert.ok(Math.abs(cutY - (floor + PLAN_CUT_HEIGHT)) < 1e-9, `offset ${offset}: cut at floor + 1.2`);
      const render = plane.localToRender([3, -2, 0]);
      const got = map(render[0], render[2]);
      assert.ok(Math.abs(got[0] - 3) < 1e-9 && Math.abs(got[1] + 2) < 1e-9, `offset ${offset}: ${got}`);
    }
  });

  it('mapPlanDrawing carries entity ids, holes and occlusion through the map', () => {
    const out = mapPlanDrawing({
      cutPolygons: [{ entityId: 7, ifcType: 'IfcWall', polygon: { outer: [{ x: 1, y: 2 }], holes: [[{ x: 3, y: 4 }]] } }],
      lines: [{ entityId: 8, category: 'projection', visibility: 'hidden', line: { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } }],
    } as unknown as Parameters<typeof mapPlanDrawing>[0], (x, z) => [x * 10, z * 10]);
    assert.deepEqual(out.polygons[0], { entityId: 7, ifcType: 'IfcWall', outer: [[10, 20]], holes: [[[30, 40]]] });
    assert.deepEqual(out.lines[0], { a: [0, 0], b: [10, 10], entityId: 8, category: 'projection', hidden: true });
  });
});

describe('useConstructionUnderlay on the shared cut', () => {
  it('draws a wall cut at floor + 1.2 m in the room frame (ifcX, ifcY)', async () => {
    // A 4 m × 0.2 m wall, 3 m tall, at ifc (0..4, 0..0.2): render z = −ifcY.
    const geometry = { ...useViewerStore.getState().geometryResult, meshes: [box(90, [0, 0, -0.2], [4, 3, 0])] } as GeometryResult;
    useViewerStore.setState({ geometryResult: geometry });
    let seen: UnderlayLine[] = [];
    function Probe() {
      seen = useConstructionUnderlay(true, 0).lines;
      return null;
    }
    render(<Probe />);
    await settle();
    assert.ok(seen.length > 0, 'the wall is cut');
    for (const l of seen) {
      for (const [x, y] of [l.a, l.b]) assert.ok(x > -1e-6 && x < 4 + 1e-6 && y > -1e-6 && y < 0.2 + 1e-6, `(${x}, ${y}) inside the wall's plan`);
    }
  });

  it('re-cuts when an edit changes the meshes in place (#6394 review: the key carries the versions)', async () => {
    const meshes = [box(90, [0, 0, -0.2], [4, 3, 0])];
    const geometry = { ...useViewerStore.getState().geometryResult, meshes } as GeometryResult;
    useViewerStore.setState({ geometryResult: geometry });
    let seen: UnderlayLine[] = [];
    function Probe() {
      seen = useConstructionUnderlay(true, 0).lines;
      return null;
    }
    render(<Probe />);
    await settle();
    const maxX = () => Math.max(...seen.flatMap((l) => [l.a[0], l.b[0]]));
    assert.ok(Math.abs(maxX() - 4) < 1e-6);
    // The same geometryResult object, its mesh swapped in place, then the version bump an edit makes.
    meshes[0] = box(90, [0, 0, -0.2], [6, 3, 0]);
    act(() => useViewerStore.setState((s) => ({ mutationVersion: s.mutationVersion + 1 })));
    await settle();
    assert.ok(Math.abs(maxX() - 6) < 1e-6, `the underlay follows the edit (max x ${maxX()})`);
  });

  it("never shows another storey's cut while the new one is pending (#6394 review)", async () => {
    const geometry = { ...useViewerStore.getState().geometryResult, meshes: [box(90, [0, 0, -0.2], [4, 3, 0])] } as GeometryResult;
    useViewerStore.setState({ geometryResult: geometry });
    let seen: UnderlayLine[] = [];
    let floor = 0;
    function Probe() {
      seen = useConstructionUnderlay(true, floor).lines;
      return null;
    }
    const ui = render(<Probe />);
    await settle();
    assert.ok(seen.length > 0);
    // Another floor: the old cut must go at once, not after the debounce.
    floor = 10;
    act(() => useViewerStore.setState((s) => ({ mutationVersion: s.mutationVersion + 1 })));
    assert.equal(seen.length, 0, 'the previous floor is not drawn under the new one');
    void ui;
  });
});

