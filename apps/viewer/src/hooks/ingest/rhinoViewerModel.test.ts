/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Rhino import adapter, driven with real `RhinoImport` data: `.3dm` bytes
 * through the real `readRhino3dm` and the worker job's axis swap, exactly as
 * the worker produces them. Two inputs — a crafted file whose coordinate and
 * user text are known exactly, and a Rhino 8 authored fixture.
 *
 * Spec: docs/architecture/rhino-3dm-import.md.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, it, mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import rhino3dm from 'rhino3dm';
import { isValidIfcGuid } from '@ifc-lite/encoding';
import { PropertyValueType } from '@ifc-lite/data';

import { RhinoImportError } from '@/lib/import/rhino-import-client';
import {
  CRAFTED_GLOBAL_ID,
  CRAFTED_VERTEX_VIEWER,
  craftRhino3dm,
  rhinoImportOf as importOf,
  rhinoPayloadOf as payloadOf,
} from '@/test/rhino-3dm-fixture.js';
import { rhinoViewerModel } from './rhinoViewerModel.js';

const samples = new URL('../../../../../tests/models/rhino/mcneel-rhino3dm/', import.meta.url);
const sample = (name: string) => new Uint8Array(readFileSync(new URL(name, samples)));
const samplesAbsent = !existsSync(new URL('file3dm_stuff.3dm', samples));

// The reader reports what it could not draw through console.warn; the tests
// assert the payload, not the log, so the log is silenced for all of them.
beforeEach(() => mock.method(console, 'warn', () => undefined));
afterEach(() => mock.restoreAll());

describe('rhinoViewerModel, crafted .3dm', () => {
  it('builds one entity per Rhino object, with the class and GlobalId the user text states', async () => {
    const { dataStore, schemaVersion } = await payloadOf(await craftRhino3dm());

    assert.equal(dataStore.entityCount, 2);
    assert.deepEqual(dataStore.getEntity(1), { expressId: 1, type: 'IfcWall', attributes: [] });
    assert.deepEqual(dataStore.getEntitiesByType('IfcWall').map((e) => e.expressId), [1]);
    assert.equal(dataStore.entities.getGlobalId(1), CRAFTED_GLOBAL_ID);
    assert.equal(dataStore.entities.getName(1), 'South wall');
    assert.equal(dataStore.entities.getDescription(1), 'Load bearing');
    // An object with no IFC::Class is a proxy (decision D2), and its GlobalId
    // is derived from the Rhino UUID, so it is a valid GUID all the same.
    assert.equal(dataStore.getEntity(2)?.type, 'IfcBuildingElementProxy');
    assert.equal(isValidIfcGuid(dataStore.entities.getGlobalId(2)), true);
    // The schema the classes belong to. What backs the store is `sourceKind`,
    // asserted in rhinoViewerModel.store-kind.test.ts.
    assert.equal(schemaVersion, 'IFC4');
  });

  it('serves the reader property sets as the store properties', async () => {
    const { dataStore } = await payloadOf(await craftRhino3dm());

    const sets = dataStore.getProperties(1);
    assert.deepEqual(sets.map((set) => set.name), ['IFC', 'Pset_WallCommon', 'Attribute User Text', 'Rhino']);
    assert.deepEqual(sets[1].properties, [
      { name: 'IsExternal', type: PropertyValueType.Label, value: 'TRUE' },
    ]);
    // A key with no set stays under its whole name, verbatim.
    assert.deepEqual(sets[2].properties.map((p) => [p.name, p.value]), [['Comment', 'left as written']]);
    assert.equal(dataStore.properties.getPropertyValue(1, 'Rhino', 'Layer'), 'Walls');
    assert.deepEqual(dataStore.getQuantities(1), [], 'a .3dm carries no quantities');
  });

  it('keeps the millimetre file in metres and the known vertex at its viewer coordinate', async () => {
    const { dataStore, geometryResult } = await payloadOf(await craftRhino3dm());

    // The reader scaled to metres, so the store's own scale is 1.
    assert.equal(dataStore.lengthUnitScale, 1);
    assert.equal(dataStore.lengthUnitSource, 'declared');

    const wall = geometryResult.meshes.find((mesh) => mesh.expressId === 1);
    assert.ok(wall, 'the wall is drawn');
    // World position of vertex i is origin + positions[3i..3i+3]: the first
    // vertex is the origin, so the mm coordinate lands here exactly.
    assert.deepEqual([...(wall.origin ?? [])], [...CRAFTED_VERTEX_VIEWER]);
    assert.deepEqual([...wall.positions.slice(0, 3)], [0, 0, 0]);
    // 100 mm along Rhino +x and +y: +x and -z in the viewer frame.
    assert.deepEqual([...wall.positions.slice(3, 9)].map((v) => Math.round(v * 1000)), [100, 0, 0, 100, 0, -100]);
    // A Rhino +z face normal points at viewer +y.
    assert.deepEqual([...wall.normals.slice(0, 3)], [0, 1, 0]);
  });

  it('carries each colour source through as the mesh colour', async () => {
    const { geometryResult } = await payloadOf(await craftRhino3dm());

    const byObject = geometryResult.meshes.find((mesh) => mesh.expressId === 1);
    const byLayer = geometryResult.meshes.find((mesh) => mesh.expressId === 2);
    assert.deepEqual(byObject?.color, [0, 0, 1, 1], 'the object states blue');
    assert.deepEqual(byLayer?.color, [1, 0, 0, 1], 'the proxy takes its red layer');
    assert.deepEqual(geometryResult.meshes.map((mesh) => mesh.ifcType), ['IfcWall', 'IfcBuildingElementProxy']);
    assert.equal(geometryResult.totalTriangles, 2);
    assert.equal(geometryResult.totalVertices, 6);
    // Bounds span both triangles, in the viewer frame (f32 vertices, so the
    // 1.1 m corner is compared at millimetre resolution).
    const { max } = geometryResult.coordinateInfo.originalBounds;
    assert.deepEqual([max.x, max.y, max.z].map((v) => Math.round(v * 1000)), [1100, 3000, 0]);
  });
});

describe('rhinoViewerModel, a point cloud far from the origin', () => {
  it('keeps the reader double origin on the asset, so a national-grid point keeps its millimetres (#10029)', async () => {
    const rhino = await rhino3dm();
    const file = new rhino.File3dm();
    file.settings().modelUnitSystem = rhino.UnitSystem.Meters;
    const cloud = new rhino.PointCloud();
    // One f32 step at 2,600,000 m is 0.25 m, so folding the origin into the
    // positions would move these points by up to 12 cm.
    cloud.add([2_600_000.123, 1_200_000.456, 400.789]);
    cloud.add([2_600_001.123, 1_200_000.456, 400.789]);
    file.objects().add(cloud, new rhino.ObjectAttributes());
    const { geometryResult } = await payloadOf(file.toByteArray());

    const asset = geometryResult.pointClouds?.[0];
    assert.ok(asset?.origin, 'the cloud carries an f64 origin');
    const origin = asset.origin;
    // Viewer Y-up is `x, z, -y` of the file's Z-up point.
    const expected = [
      [2_600_000.123, 400.789, -1_200_000.456],
      [2_600_001.123, 400.789, -1_200_000.456],
    ];
    expected.forEach((point, i) => point.forEach((value, axis) => {
      const world = origin[axis] + asset.chunk.positions[i * 3 + axis];
      assert.ok(Math.abs(world - value) < 1e-3, `point ${i} axis ${axis}: ${world}`);
    }));
    // Scene bounds are absolute: origin plus the cloud's relative bbox.
    const { min, max } = geometryResult.coordinateInfo.originalBounds;
    const close = (actual: number, want: number) => assert.ok(Math.abs(actual - want) < 1e-3, `${actual} vs ${want}`);
    [[min.x, 2_600_000.123], [min.y, 400.789], [min.z, -1_200_000.456],
      [max.x, 2_600_001.123], [max.y, 400.789], [max.z, -1_200_000.456]].forEach(([a, w]) => close(a, w));
  });
});

describe(`rhinoViewerModel, Rhino 8 authored fixture${samplesAbsent ? ' (skipped: run pnpm fixtures)' : ''}`, { skip: samplesAbsent }, () => {
  it('loads file3dm_stuff.3dm: five entities, the one drawable mesh, and its point cloud', async () => {
    const { dataStore, geometryResult } = await payloadOf(sample('file3dm_stuff.3dm'));

    assert.equal(dataStore.entityCount, 5);
    for (let expressId = 1; expressId <= 5; expressId++) {
      assert.equal(dataStore.getEntity(expressId)?.type, 'IfcBuildingElementProxy', `entity ${expressId}`);
      assert.equal(isValidIfcGuid(dataStore.entities.getGlobalId(expressId)), true, `entity ${expressId} GlobalId`);
    }
    // Only the Brep on the green Points layer carries a render mesh.
    assert.equal(geometryResult.meshes.length, 1);
    assert.equal(geometryResult.meshes[0].expressId, 5);
    assert.deepEqual(geometryResult.meshes[0].color, [0, 127 / 255, 0, 1]);
    // The file's point cloud rides the payload's pointClouds (decision D6).
    assert.equal(geometryResult.pointClouds?.length, 1);
    assert.equal(geometryResult.pointClouds?.[0].expressId, 4);
    assert.equal(geometryResult.pointClouds?.[0].chunk.pointCount, 8);
    // No per-point colours in the file, so every point takes the colour the
    // object's layer gives it: the green Points layer.
    assert.deepEqual([...(geometryResult.pointClouds?.[0].chunk.colors ?? []).slice(0, 3)], [...new Float32Array([0, 127 / 255, 0])]);
    // The entity flag says what the viewer drew, so the three curve entities
    // do not claim geometry the viewer has not got.
    assert.deepEqual([1, 2, 3, 4, 5].map((id) => dataStore.entities.hasGeometry(id)), [false, false, false, true, true]);
  });

  it('refuses a file whose only drawable objects are curves', async () => {
    // blocks.3dm draws two block instances whose one drawable member is a curve.
    const result = await importOf(sample('blocks.3dm'));
    assert.deepEqual([result.meshes.length, result.pointClouds.length, result.curves.length], [0, 0, 2]);
    assert.throws(
      () => rhinoViewerModel(result, new ArrayBuffer(0), 1),
      (error: unknown) => error instanceof RhinoImportError && error.code === 'no-renderable-geometry',
    );
  });

  it('reads mesh.3dm, a millimetre Rhino mesh, into one proxy with 276 triangles', async () => {
    const { dataStore, geometryResult } = await payloadOf(sample('mesh.3dm'));

    assert.equal(dataStore.entityCount, 1);
    assert.equal(dataStore.lengthUnitSource, 'declared');
    assert.equal(geometryResult.totalTriangles, 276);
    assert.equal(geometryResult.totalVertices, 420);
    assert.equal(geometryResult.meshes[0].expressId, 1);
  });
});
