/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The page the dialog quotes before export: with several cutting planes on it is
 * the page of what ALL of them keep (#7545), not of the first plane alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { estimateViewPdfLayout } from './view-pdf-page-estimate.js';
import type { ViewCameraSnapshot } from './generate-view-pdf.js';

function box(): MeshData {
  const positions: number[] = [];
  for (const x of [0, 4]) for (const y of [0, 3]) for (const z of [0, 2]) positions.push(x, y, z);
  return {
    expressId: 1, ifcType: 'IfcWall', modelIndex: 0, positions: new Float32Array(positions),
    normals: new Float32Array(positions.length), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1],
  };
}

const CAMERA: ViewCameraSnapshot = {
  position: { x: 2, y: 1.5, z: 12 }, target: { x: 2, y: 1.5, z: 1 }, up: { x: 0, y: 1, z: 0 }, projectionMode: 'orthographic',
};
const X = { x: 1, y: 0, z: 0 };

describe('estimateViewPdfLayout with several cutting planes (#7545)', () => {
  const widthWith = (options: Parameters<typeof estimateViewPdfLayout>[3]) =>
    estimateViewPdfLayout([box()], CAMERA, 100, { includeScaleStamp: false, ...options })?.drawingWidthMm;

  it('quotes the extent every plane keeps', () => {
    assert.equal(widthWith({}), 40, 'uncut: 4 m at 1:100');
    assert.equal(widthWith({ keptHalfSpace: { normal: X, offset: 3 } }), 30, 'x <= 3 alone');
    assert.equal(
      widthWith({ keptHalfSpace: { normal: X, offset: 3 }, extraKeptHalfSpaces: [{ normal: { x: -1, y: 0, z: 0 }, offset: -1 }] }),
      20,
      'x <= 3 and x >= 1',
    );
  });

  it('has nothing to estimate when the planes keep nothing together', () => {
    assert.equal(
      estimateViewPdfLayout([box()], CAMERA, 100, {
        keptHalfSpace: { normal: X, offset: 1 },
        extraKeptHalfSpaces: [{ normal: { x: -1, y: 0, z: 0 }, offset: -3 }],
      }),
      null,
    );
  });
});
