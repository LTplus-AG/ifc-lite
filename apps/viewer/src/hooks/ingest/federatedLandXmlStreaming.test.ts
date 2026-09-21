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

function twoTriangleMesh(expressId: number, x = 0) {
  return {
    expressId,
    positions: new Float32Array([x, 0, 0, x + 2, 0, 0, x + 2, 2, 0, x, 2, 0]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
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
    await plan.admit({ mesh: mesh(1) });
    await plan.admit({ mesh: mesh(2, 10) });
    plan.freezeAdmission();
    await plan.publish(mesh(1));
    assert.deepEqual(registry.fromGlobalId(uploaded[0]!), { modelId: 'terrain', expressId: 1 });
    await plan.publish(mesh(2, 10));
    const geometry = { meshes: [mesh(1), mesh(2, 10)], totalVertices: 6, totalTriangles: 2, coordinateInfo: sourceCoordinateInfo };
    plan.complete(geometry);
    plan.verify(geometry);
    assert.equal(uploaded.length, 2);
    assert.deepEqual(geometry.meshes.map((entry) => entry.expressId), [1, 2]);
    assert.deepEqual(plan.preAlignment.positions.map((positions) => positions[0]), [0, 10],
      'future anchor changes restore source-frame components, not already-aligned meshes');
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
    await plan.admit({ mesh: mesh(1) });
    plan.freezeAdmission();
    await plan.publish(mesh(1));
    current = false;
    assert.throws(() => plan.complete({ meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: sourceCoordinateInfo }), /cancelled/);
    plan.rollback();
    assert.equal(registry.getOffset('stale'), null);
    assert.equal(removed.length, 1);
    assert.equal(plan.preAlignment.positions.length, 0, 'rollback must release source-frame snapshots');
  });

  it('derives an unanchored frame from the largest measured component, not the aggregate envelope (#5161)', async () => {
    const registry = new FederationRegistry();
    const plan = new FederatedLandXmlStreamingPlan({
      modelId: 'dominant', componentCount: 2, sourceCoordinateInfo, registry,
      resources: { publish: () => {}, remove: () => {} }, isCurrent: () => true,
    });
    await plan.measure(mesh(1, 2_000_000));
    await plan.measure(twoTriangleMesh(2, 0));
    plan.freeze();
    await plan.admit({ mesh: mesh(1, 2_000_000) });
    await plan.admit({ mesh: twoTriangleMesh(2, 0) });
    plan.freezeAdmission();
    assert.deepEqual(plan.coordinateInfo.originShift, { x: 1, y: 1, z: 0 });
  });

  it('keeps the first measured component as the deterministic dominant tie-breaker (#5161)', async () => {
    const registry = new FederationRegistry();
    const plan = new FederatedLandXmlStreamingPlan({
      modelId: 'dominant-tie', componentCount: 2, sourceCoordinateInfo, registry,
      resources: { publish: () => {}, remove: () => {} }, isCurrent: () => true,
    });
    await plan.measure(mesh(1, 2_000_000));
    await plan.measure(mesh(2, 0));
    plan.freeze();
    await plan.admit({ mesh: mesh(1, 2_000_000) });
    await plan.admit({ mesh: mesh(2, 0) });
    plan.freezeAdmission();
    assert.deepEqual(plan.coordinateInfo.originShift, { x: 2_000_000.5, y: 0.5, z: 0 });
  });

  it('atomically rejects a precision-overflow source group before publication (#5161)', async () => {
    const registry = new FederationRegistry();
    const plan = new FederatedLandXmlStreamingPlan({
      modelId: 'precision-group', componentCount: 3, sourceCoordinateInfo, registry,
      resources: { publish: () => {}, remove: () => {} }, isCurrent: () => true,
    });
    const wide = mesh(1, 0);
    wide.positions[3] = 1_500_000;
    const grouped = mesh(2, 2);
    const retained = mesh(3, 10);
    await plan.measure(wide);
    await plan.measure(grouped);
    await plan.measure(retained);
    plan.freeze();
    await plan.admit({ mesh: wide, frameGroup: 1 });
    await plan.admit({ mesh: grouped, frameGroup: 1 });
    await plan.admit({ mesh: retained, frameGroup: 2 });
    plan.freezeAdmission();
    await plan.publish(wide);
    await plan.publish(grouped);
    await plan.publish(retained);
    const geometry = { meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: sourceCoordinateInfo };
    plan.complete(geometry);
    assert.deepEqual(geometry.meshes.map((entry) => entry.expressId), [3]);
    assert.deepEqual(geometry.coordinateInfo.originalBounds, {
      min: { x: 10, y: 0, z: 0 }, max: { x: 11, y: 1, z: 0 },
    });
  });

  it('rejects a nonempty federation envelope when every group violates precision (#5161)', async () => {
    const registry = new FederationRegistry();
    const plan = new FederatedLandXmlStreamingPlan({
      modelId: 'all-refused', componentCount: 1, sourceCoordinateInfo, registry,
      resources: { publish: () => {}, remove: () => {} }, isCurrent: () => true,
    });
    const tooWide = mesh(1);
    tooWide.positions[3] = 1_500_000;
    await plan.measure(tooWide);
    plan.freeze();
    await plan.admit({ mesh: tooWide, frameGroup: 1 });
    assert.throws(() => plan.freezeAdmission(), /rejected every render component/);
    assert.equal(registry.getOffset('all-refused'), null);
  });

  it('requires the admitted source-slot order and contiguous surface groups (#5161)', async () => {
    const registry = new FederationRegistry();
    const plan = new FederatedLandXmlStreamingPlan({
      modelId: 'ordered-groups', componentCount: 3, sourceCoordinateInfo, registry,
      resources: { publish: () => {}, remove: () => {} }, isCurrent: () => true,
    });
    await plan.measure(mesh(1));
    await plan.measure(mesh(2));
    await plan.measure(mesh(3));
    plan.freeze();
    await assert.rejects(plan.admit({ mesh: mesh(2), frameGroup: 1 }), /source-slot ordering/);
    await plan.admit({ mesh: mesh(1), frameGroup: 1 });
    await plan.admit({ mesh: mesh(2), frameGroup: 2 });
    await assert.rejects(plan.admit({ mesh: mesh(3), frameGroup: 1 }), /non-contiguous source group/);
  });
});
