/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// The changed-test oracle deletes new production modules. Assert the required
// operation inside the test rather than failing ESM loading before it runs.
const affine = await import('./affine-triangles').catch((error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error
    && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) return null;
  throw error;
});
function referenceAffineTriangles(...args: Parameters<NonNullable<typeof affine>['referenceAffineTriangles']>) {
  assert.ok(affine, 'Four-corner raster mapping must be available.');
  return affine.referenceAffineTriangles(...args);
}

test('reference triangles preserve raster corner landmarks through reflected nonrectangular placement (#6615)', () => {
  const corners = [{x:10,y:20},{x:2,y:22},{x:3,y:29},{x:11,y:32}];
  const triangles = referenceAffineTriangles(corners, 400, 300);
  assert.equal(triangles.length, 2);
  for (const [index, source] of [[0,[[0,0],[400,0],[400,300]]], [1,[[0,0],[400,300],[0,300]]]] as const) {
    const {matrix,vertices} = triangles[index];
    source.forEach(([x,y], vertex) => {
      assert.ok(Math.abs(matrix[0]*x+matrix[2]*y+matrix[4]-vertices[vertex].x) < 1e-10);
      assert.ok(Math.abs(matrix[1]*x+matrix[3]*y+matrix[5]-vertices[vertex].y) < 1e-10);
    });
    assert.ok(matrix[0]*matrix[3]-matrix[1]*matrix[2] < 0, 'reflection is preserved rather than changed to an axis-aligned box');
  }
});

test('reference affine mapping rejects invalid raster dimensions and individual collapsed triangles (#6615)', () => {
  const corners = [{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:0,y:1}];
  assert.equal(referenceAffineTriangles(corners, 1, 1).length, 1, 'only the collinear first triangle is suppressed');
  for (const [width,height] of [[0,1],[1,-1],[Infinity,1],[1,NaN]]) {
    assert.equal(referenceAffineTriangles(corners,width,height).length,0);
  }
  assert.equal(referenceAffineTriangles([...corners.slice(0,3),{x:Infinity,y:1}],1,1).length,0);
});
