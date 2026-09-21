/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  boundsFitRenderFrame, placeComponentsInKnownRenderFrame,
} from './landXmlRenderFrame.js';

describe('LandXML render frame acceptance (#5049)', () => {
  it('accepts a centimetre-scale component at a 5,000-km survey origin', () => {
    assert.equal(boundsFitRenderFrame({
      min: { x: 5_000_000.015625, y: 20, z: -4 },
      max: { x: 5_000_000.025625, y: 20.01, z: -3.99 },
    }, { x: 5_000_000.015625, y: 20, z: -4 }), true);
  });

  it('refuses a compact island outside the shared render-frame envelope (#5010)', () => {
    assert.equal(boundsFitRenderFrame({
      min: { x: 5_000_000.015625, y: 20, z: -4 },
      max: { x: 5_000_000.025625, y: 20.01, z: -3.99 },
    }, { x: 0, y: 0, z: 0 }), false);
  });

  it('accepts a 1,500-km span centred on the shared frame (#5049)', () => {
    assert.equal(boundsFitRenderFrame({
      min: { x: -750_000, y: 0, z: 0 },
      max: { x: 750_000, y: 1, z: 1 },
    }, { x: 0, y: 0, z: 0 }), true);
  });

  it('refuses every member of a source group when one member misses the frozen frame (#5161)', () => {
    const component = (expressId: number, x: number, frameGroup: string) => ({
      mesh: {
        expressId, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]),
        color: [0.42, 0.62, 0.32, 1] as [number, number, number, number], origin: [x, 0, 0] as [number, number, number],
      },
      bounds: { min: { x, y: 0, z: 0 }, max: { x: x + 1, y: 1, z: 0 } },
      frameGroup,
    });
    const near = component(1, 0, 'surface-a');
    const far = component(2, 1_000_001, 'surface-a');
    const independent = component(3, 5, 'surface-b');
    const placement = placeComponentsInKnownRenderFrame(
      [near, far, independent], { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false }, [],
    );
    assert.deepEqual(placement.placed.map(({ mesh }) => mesh.expressId), [3]);
    assert.deepEqual(placement.dropped.map(({ mesh }) => mesh.expressId), [1, 2]);
  });
});
