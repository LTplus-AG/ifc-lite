/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBCFFromIDSReport, readBCF, writeBCF } from '@ifc-lite/bcf';
import type { BCFPerspectiveCamera, EntityBoundsInput, IDSReportInput } from '@ifc-lite/bcf';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { collectIdsBcfEntityBounds } from './idsBcfBounds.js';

type Geometry = Pick<GeometryResult, 'meshes' | 'instancedGeometryAabbs'>;
const near = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 3, z: 1 } };
const far = { min: { x: 50, y: 10, z: -20 }, max: { x: 52, y: 13, z: -19 } };
const guids = ['2O2Fr$t4X7Zf8NOew3FL01', '3P3Gs$u5Y8Ag9OPfx4GM02'];

function report(secondModel = 'A'): IDSReportInput {
  return {
    title: 'Missing fire rating',
    specificationResults: [{
      specification: { name: 'Wall fire rating' }, status: 'fail',
      applicableCount: 3, failedCount: 2, passedCount: 1,
      entityResults: [
        ...guids.map((globalId, i) => ({
          modelId: i === 0 ? 'A' : secondModel, expressId: i === 0 ? 10 : 20,
          entityType: 'IfcWall', globalId, passed: false,
          requirementResults: [{ status: 'fail' as const, facetType: 'property', checkedDescription: 'FireRating must exist' }],
        })),
        { modelId: 'A', expressId: 30, entityType: 'IfcWall', passed: true, requirementResults: [] },
      ],
    }],
  };
}

function mesh(id: number): MeshData {
  return {
    expressId: id, positions: new Float32Array([0, 0, 0, 2, 3, 1, 0, 3, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1],
  };
}

// Projection oracle: every corner must be in front of the serialized camera
// and within BOTH frustum angles, including the Y-up -> IFC Z-up conversion.
function assertFramed(camera: BCFPerspectiveCamera, box: EntityBoundsInput): void {
  const d = camera.cameraDirection;
  const u = camera.cameraUpVector;
  const right = { x: d.y * u.z - d.z * u.y, y: d.z * u.x - d.x * u.z, z: d.x * u.y - d.y * u.x };
  const length = Math.hypot(right.x, right.y, right.z);
  right.x /= length; right.y /= length; right.z /= length;
  const up = { x: right.y * d.z - right.z * d.y, y: right.z * d.x - right.x * d.z, z: right.x * d.y - right.y * d.x };
  const tanV = Math.tan(camera.fieldOfView * Math.PI / 360);
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const v = { x: x - camera.cameraViewPoint.x, y: -z - camera.cameraViewPoint.y, z: y - camera.cameraViewPoint.z };
    const dot = (a: typeof v) => v.x * a.x + v.y * a.y + v.z * a.z;
    const depth = dot(d);
    assert.ok(depth > 0);
    // BCF 2.1 does not serialize AspectRatio; the reporter's default is 16/9.
    assert.ok(Math.abs(dot(right)) <= depth * tanV * (camera.aspectRatio ?? 16 / 9));
    assert.ok(Math.abs(dot(up)) <= depth * tanV);
  }
}

describe('#7974 grouped IDS BCF cameras', () => {
  for (const federated of [false, true]) {
    for (const version of ['2.1', '3.0'] as const) {
      it(`exports a camera framing flat AND instanced failures (${federated ? 'N models' : '1 model'}, BCF ${version})`, async () => {
        const input = report(federated ? 'B' : 'A');
        const first: Geometry = { meshes: [mesh(federated ? 1_000_010 : 10)] };
        const second: Geometry = { meshes: [], instancedGeometryAabbs: new Map([
          [federated ? 2_000_020 : 20, { min: [50, 10, -20], max: [52, 13, -19] }],
        ]) };
        if (!federated) first.instancedGeometryAabbs = second.instancedGeometryAabbs;
        const models = new Map([['A', { geometryResult: first }]]);
        if (federated) models.set('B', { geometryResult: second });
        const bounds = collectIdsBcfEntityBounds(input, false, models, null,
          (model, id) => federated ? (model === 'A' ? 1_000_000 : 2_000_000) + id : id,
          () => undefined);
        const project = createBCFFromIDSReport(input, { topicGrouping: 'per-specification', entityBounds: bounds, version });
        const archive = await writeBCF(project);
        const restored = await readBCF(new Uint8Array(await archive.arrayBuffer()));
        assert.equal(restored.topics.size, 1, 'grouping must remain one topic per specification');
        const topic = [...restored.topics.values()][0];
        assert.equal(topic.viewpoints.length, 1);
        const vp = topic.viewpoints[0];
        assert.ok(vp.perspectiveCamera, 'a component-only viewpoint cannot zoom to failures');
        assertFramed(vp.perspectiveCamera, near);
        assertFramed(vp.perspectiveCamera, far);
        assert.deepEqual(vp.components?.selection?.map(c => c.ifcGuid), guids);
        assert.equal(vp.components?.visibility?.defaultVisibility, false);
        assert.deepEqual(vp.components?.visibility?.exceptions?.map(c => c.ifcGuid), guids);
        assert.deepEqual(vp.components?.coloring?.[0].components.map(c => c.ifcGuid), guids);
        assert.ok(topic.comments.every(c => c.viewpointGuid === vp.guid));
      });
    }
  }

  it('uses live scene bounds after mesh release, even without geometryResult', () => {
    const calls: number[] = [];
    const bounds = collectIdsBcfEntityBounds(report(), false, new Map([['A', {}]]), null, (_model, id) => id, id => {
      calls.push(id);
      return id === 10 ? near : far;
    });
    const project = createBCFFromIDSReport(report(), { topicGrouping: 'per-specification', entityBounds: bounds });
    const camera = [...project.topics.values()][0].viewpoints[0].perspectiveCamera;
    assert.ok(camera);
    assertFramed(camera, near);
    assertFramed(camera, far);
    assert.deepEqual(calls, [10, 20], 'passing entities do not require a frame');
  });

  it('keeps genuinely unavailable bounds missing instead of inventing a group frame', () => {
    const input = report('B');
    const bounds = collectIdsBcfEntityBounds(input, false,
      new Map([['A', { geometryResult: { meshes: [mesh(10), mesh(20)] } }], ['B', {}]]),
      null, (_model, id) => id, () => undefined);
    assert.ok(bounds.has('A:10'));
    assert.equal(bounds.has('B:20'), false, 'never borrow a different loaded model\'s meshes');
    const project = createBCFFromIDSReport(input, { topicGrouping: 'per-specification', entityBounds: bounds });
    assert.equal([...project.topics.values()][0].viewpoints[0].perspectiveCamera, undefined);
  });

  it('frames the whole scene entity when flat meshes retain only some of its pieces', () => {
    const whole = { min: { x: 0, y: 0, z: -20 }, max: { x: 52, y: 13, z: 1 } };
    const bounds = collectIdsBcfEntityBounds(report(), false,
      new Map([['A', { geometryResult: { meshes: [mesh(10)] } }]]), null,
      (_model, id) => id, id => id === 10 ? whole : far);
    const project = createBCFFromIDSReport(report(), { topicGrouping: 'per-specification', entityBounds: bounds });
    const camera = [...project.topics.values()][0].viewpoints[0].perspectiveCamera;
    assert.ok(camera);
    assertFramed(camera, whole);
  });
});
