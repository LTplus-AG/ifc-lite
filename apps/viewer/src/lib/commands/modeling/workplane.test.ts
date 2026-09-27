/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Storey workplane composition (charter #6232, WP2): the reposition
 * placement and a same-CRS alignment sit on top of the storey/RTC/shift frame,
 * the map inverts exactly, a ray lands on the plane, and a reprojected model
 * is refused. The real-mesh calibration lives in workplane.calibration.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import type { Vec3 } from '@/lib/snap/types';
import { buildStoreyWorkplane, composeStoreyWorkplane, isWorkplane } from './workplane.js';
import type { StoreyWorkplaneFrame } from './workplane.js';

const close = (a: readonly number[], b: readonly number[], what: string) =>
  assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-9), `${what}: ${a} vs ${b}`);

const FRAME: StoreyWorkplaneFrame = {
  modelId: 'm',
  spec: { kind: 'storey', storeyId: 1, offset: 0.5 },
  // Storey turned 90° with its origin at world (10, 20).
  plan: { origin: [10, 20], axisX: [0, 1] },
  elevation: 3,
  coordinateInfo: { originShift: { x: 1, y: 2, z: 3 }, wasmRtcOffset: { x: 100, y: 200, z: 30 } },
  alignment: null,
  placement: { translation: [0, 0, 0], rotation: { angle: 0, pivot: [0, 0, 0] } },
};

describe('storey workplane (#6232 WP2)', () => {
  it('maps storey-local through plan frame, RTC, Y-up swap and origin shift', () => {
    const plane = composeStoreyWorkplane(FRAME);
    // local (1, 0) → world plan (10, 21); − rtc → (−90, −179); Y-up → x −90, z 179; − shift → (−91, 3.5 − 2, 176)
    close(plane.localToRender([1, 0, 0]), [-91, 1.5, 176], 'forward');
    close(plane.renderToLocal([-91, 1.5, 176]), [1, 0, 0], 'inverse');
  });

  it('applies the model placement on top, and still inverts', () => {
    const moved = composeStoreyWorkplane({
      ...FRAME,
      placement: { translation: [5, -2, 1], rotation: { angle: Math.PI / 3, pivot: [4, 4, 0] } },
      alignment: { m00: 0, m01: 0, m02: -1, tx: 7, m10: 0, m11: 1, m12: 0, ty: 0, m20: 1, m21: 0, m22: 0, tz: -3 },
    });
    for (const p of [[0, 0, 0], [3.5, -2, 0], [-1, 7, 1.2]] as Vec3[]) {
      close(moved.renderToLocal(moved.localToRender(p)), p, `round trip ${p}`);
    }
    // The placement changed the answer.
    assert.notDeepEqual(moved.localToRender([1, 0, 0]), composeStoreyWorkplane(FRAME).localToRender([1, 0, 0]));
  });

  it('intersects a ray with the plane and reports the local point', () => {
    const plane = composeStoreyWorkplane(FRAME);
    const target = plane.localToRender([2, -3, 0]);
    const hit = plane.intersectRay({ origin: [target[0] + 4, target[1] + 10, target[2] - 1], direction: [-4, -10, 1] });
    assert.ok(hit);
    close(hit.local, [2, -3], 'local');
    close(hit.render, target, 'render');
    assert.equal(plane.intersectRay({ origin: [0, 100, 0], direction: [1, 0, 0] }), null, 'parallel ray misses');
    assert.equal(plane.intersectRay({ origin: [0, 100, 0], direction: [0, 1, 0] }), null, 'ray pointing away misses');
  });

  it('refuses a reprojected model and a missing one', async () => {
    await seedModelingSession();
    const s = useViewerStore.getState();
    assert.ok(isWorkplane(buildStoreyWorkplane(s, MODEL_ID, STOREY, 0)), 'the plain model has a workplane');
    const model = s.models.get(MODEL_ID)!;
    useViewerStore.setState({ models: new Map([[MODEL_ID, { ...model, federationAlignmentStatus: 'reprojected' }]]) });
    const refused = buildStoreyWorkplane(useViewerStore.getState(), MODEL_ID, STOREY, 0);
    assert.ok('refused' in refused && /reprojected/.test(refused.refused));
    assert.ok('refused' in buildStoreyWorkplane(useViewerStore.getState(), 'nope', STOREY, 0));
  });
});
