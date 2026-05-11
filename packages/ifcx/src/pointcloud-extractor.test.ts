/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractPointClouds } from './pointcloud-extractor.js';
import { ATTR, type ComposedNode } from './types.js';

function createNode(path: string): ComposedNode {
  return { path, attributes: new Map(), children: new Map() };
}

function ifcClass(code: string) {
  return { code, uri: `https://example.invalid/${code}` };
}

describe('extractPointClouds', () => {
  it('emits a chunk for points::array attributes with z-up→y-up swap', () => {
    const node = createNode('scan-1');
    node.attributes.set(ATTR.CLASS, ifcClass('IfcGeographicElement'));
    node.attributes.set('points::array', {
      // Z-up source: (1, 2, 3) should become Y-up (1, 3, -2)
      positions: [[1, 2, 3]],
    });
    const composed = new Map<string, ComposedNode>([[node.path, node]]);
    const pathToId = new Map([[node.path, 42]]);

    const result = extractPointClouds(composed, pathToId);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].expressId, 42);
    assert.strictEqual(result[0].pointCount, 1);
    assert.deepStrictEqual(Array.from(result[0].positions), [1, 3, -2]);
  });

  it('emits a chunk for points::base64 attributes', () => {
    const positions = new Float32Array([5, 6, 7]);
    const b64 = Buffer.from(positions.buffer).toString('base64');
    const node = createNode('scan-2');
    node.attributes.set(ATTR.CLASS, ifcClass('IfcBuildingElementProxy'));
    node.attributes.set('points::base64', { positions: b64 });
    const composed = new Map<string, ComposedNode>([[node.path, node]]);
    const pathToId = new Map([[node.path, 99]]);

    const result = extractPointClouds(composed, pathToId);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(Array.from(result[0].positions), [5, 7, -6]);
  });

  it('skips nodes with no point cloud attributes', () => {
    const node = createNode('mesh-only');
    node.attributes.set(ATTR.CLASS, ifcClass('IfcWall'));
    node.attributes.set(ATTR.MESH, { points: [], faceVertexIndices: [] });
    const composed = new Map<string, ComposedNode>([[node.path, node]]);
    const pathToId = new Map([[node.path, 1]]);
    const result = extractPointClouds(composed, pathToId);
    assert.strictEqual(result.length, 0);
  });

  it('decodes a tiny ASCII PCD blob from pcd::base64', () => {
    const pcd = [
      '# .PCD test',
      'VERSION 0.7',
      'FIELDS x y z',
      'SIZE 4 4 4',
      'TYPE F F F',
      'COUNT 1 1 1',
      'WIDTH 2',
      'HEIGHT 1',
      'VIEWPOINT 0 0 0 1 0 0 0',
      'POINTS 2',
      'DATA ascii',
      '0 1 2',
      '3 4 5',
      '',
    ].join('\n');
    const b64 = Buffer.from(pcd, 'utf-8').toString('base64');
    const node = createNode('scan-3');
    node.attributes.set(ATTR.CLASS, ifcClass('IfcGeographicElement'));
    node.attributes.set('pcd::base64', b64);
    const composed = new Map<string, ComposedNode>([[node.path, node]]);
    const pathToId = new Map([[node.path, 7]]);

    const result = extractPointClouds(composed, pathToId);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pointCount, 2);
    // (0,1,2) z-up → (0,2,-1) y-up; (3,4,5) → (3,5,-4)
    assert.deepStrictEqual(Array.from(result[0].positions), [0, 2, -1, 3, 5, -4]);
  });
});
