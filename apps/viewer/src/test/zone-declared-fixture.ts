/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { IfcAPI } from '@ifc-lite/wasm';
import { IfcParser, extractProjectUnits, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { Scene } from '../../../../packages/renderer/src/scene';
import { useViewerStore } from '@/store';
import { fixtureModel } from './store-fixture';
import { ensureWasm } from './scan-slab-fixture';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { recomputeZoneAssignmentsNow } from '@/hooks/useZoneAssignmentSync';
import { computeZoneApportionmentForElement } from '@/hooks/useZoneApportionment';
import type { ZoneSet } from '@/lib/zones';

export async function seedDeclaredZoneWall(t: TestContext) {
  if (!ensureWasm(t)) return null;
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(new URL('../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url))); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { t.skip('run pnpm fixtures to fetch AC20-FZK-Haus.ifc'); return null; }
    throw error;
  }
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const id = 15042;
  assert.equal(store.entities.getTypeName(id), 'IfcWallStandardCase');
  const api = new IfcAPI(); const meshes: MeshData[] = [];
  try {
    api.setComputeGeometryHashes(0.001);
    const pre = api.buildPrePassOnce(bytes);
    const jobs = Array.from(pre.jobs).flatMap((value, index) => index % 3 === 0 && value === id ? Array.from(pre.jobs.slice(index, index + 3)) : []);
    assert.equal(jobs.length, 3, 'the real native prepass has exactly one authored wall job');
    const collection = api.processGeometryBatch(bytes, new Uint32Array(jobs), pre.unitScale,
      pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      const volumeIndex = Array.from(collection.geometryHashIds).indexOf(id);
      assert.ok(volumeIndex >= 0, 'native kernel supplies independent enclosed-volume proof');
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i); assert.ok(mesh);
        try { const color = mesh.color, origin = mesh.origin;
          meshes.push({ expressId: id, positions: mesh.positions, indices: mesh.indices, normals: mesh.normals,
            color: [color[0], color[1], color[2], color[3]], origin: [origin[0], origin[1], origin[2]],
            geometryVolume: collection.geometryVolumeValues[volumeIndex] });
        } finally { mesh.free(); }
      }
    } finally { collection.free(); }
  } finally { api.clearPrePassCache(); api.free(); }
  const scene = new Scene(); for (const mesh of meshes) scene.addMeshData(mesh);
  setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer });
  const bounds = scene.getEntityBoundingBox(id); assert.ok(bounds);
  const cut = (bounds.min.x + bounds.max.x) / 2;
  const zoneSet: ZoneSet = { id: 'arch-zones', name: 'Native declared wall zones', visible: true, createdAt: 0, updatedAt: 0, zones: [
    { id: 'left', name: 'Left', center: [(bounds.min.x + cut) / 2, (bounds.min.y + bounds.max.y) / 2, (bounds.min.z + bounds.max.z) / 2], size: [cut - bounds.min.x, bounds.max.y - bounds.min.y + 1, bounds.max.z - bounds.min.z + 1], rotationY: 0 },
    { id: 'right', name: 'Right', center: [(cut + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2, (bounds.min.z + bounds.max.z) / 2], size: [bounds.max.x - cut, bounds.max.y - bounds.min.y + 1, bounds.max.z - bounds.min.z + 1], rotationY: 0 },
  ] };
  const geometry: GeometryResult = { meshes, totalTriangles: meshes.reduce((n, m) => n + m.indices.length / 3, 0), totalVertices: meshes.reduce((n, m) => n + m.positions.length / 3, 0), coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
  const model = { ...fixtureModel('arch'), name: 'AC20-FZK-Haus.ifc', ifcDataStore: store, geometryResult: geometry };
  useViewerStore.setState({ models: new Map([['arch', model]]), activeModelId: 'arch', ifcDataStore: store, geometryResult: geometry, mutationViews: new Map(), zoneSets: [zoneSet], zoneApportionment: new Map(), zoneAssignments: new Map(), selectedEntity: { modelId: 'arch', expressId: id }, selectedEntityId: id, selectedEntities: [], selectedEntitiesSet: new Set(), selectedEntityIds: new Set() });
  recomputeZoneAssignmentsNow();
  assert.equal(useViewerStore.getState().zoneAssignments.get(id)?.[zoneSet.id].straddles, true);
  const result = computeZoneApportionmentForElement(zoneSet, id); assert.ok(result.apportionment);
  assert.equal(result.apportionment.shares.length, 2);
  return { store, id, zoneSet, apportionment: result.apportionment, quantities: extractQuantitiesOnDemand(store, id), projectUnits: extractProjectUnits(store.source, store.entityIndex) };
}
