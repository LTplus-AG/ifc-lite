/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FederationRegistry } from '@ifc-lite/renderer';
import { FederatedLandXmlStreamingPlan } from './federatedLandXmlStreaming.js';

function mesh(expressId: number, x = 0) {
  return {
    expressId,
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.42, 0.62, 0.32, 1] as [number, number, number, number],
    origin: [0, 0, 0] as [number, number, number],
  };
}

const sourceCoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 0 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 0 } },
  hasLargeCoordinates: false,
};

describe('federated LandXML streaming plan (#5050)', () => {
  it('publishes each frozen-frame component once and makes it pickable before End', async () => {
    const registry = new FederationRegistry();
    const uploaded: number[] = [];
    const plan = new FederatedLandXmlStreamingPlan({
      modelId: 'terrain', componentCount: 2, sourceCoordinateInfo, registry,
      resources: { publish: (entry) => { uploaded.push(entry.expressId); }, remove: () => {} },
      isCurrent: () => true,
    });
    await plan.measure(mesh(1));
    await plan.measure(mesh(2, 10));
    plan.freeze();
    await plan.publish(mesh(1));
    assert.deepEqual(registry.fromGlobalId(uploaded[0]!), { modelId: 'terrain', expressId: 1 });
    await plan.publish(mesh(2, 10));
    const geometry = { meshes: [mesh(1), mesh(2, 10)], totalVertices: 6, totalTriangles: 2, coordinateInfo: sourceCoordinateInfo };
    plan.complete(geometry);
    plan.verify(geometry);
    assert.equal(uploaded.length, 2);
    assert.deepEqual(geometry.meshes.map((entry) => entry.expressId), [1, 2]);
  });

  it('rolls back a stale pass without leaving a registry range or GPU resource', async () => {
    const registry = new FederationRegistry();
    const removed: number[][] = [];
    let current = true;
    const plan = new FederatedLandXmlStreamingPlan({
      modelId: 'stale', componentCount: 1, sourceCoordinateInfo, registry,
      resources: { publish: () => {}, remove: (ids) => { removed.push([...ids]); } },
      isCurrent: () => current,
    });
    await plan.measure(mesh(1));
    plan.freeze();
    await plan.publish(mesh(1));
    current = false;
    assert.throws(() => plan.complete({ meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: sourceCoordinateInfo }), /cancelled/);
    plan.rollback();
    assert.equal(registry.getOffset('stale'), null);
    assert.equal(removed.length, 1);
  });
});
