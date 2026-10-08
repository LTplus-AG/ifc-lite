/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #7142: unmodified committed Bonsai IFC through the real canonical WASM batch.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { IfcAPI } from '@ifc-lite/wasm';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { fixtureModel } from './store-fixture';
import type { ZoneSet } from '@/lib/zones';

interface PrePass {
  jobs: Uint32Array; unitScale: number; rtcOffset: number[]; needsShift: boolean;
  voidKeys: Uint32Array; voidCounts: Uint32Array; voidValues: Uint32Array;
  styleIds: Uint32Array; styleColors: Uint8Array;
}

export async function seedZoneExport() {
  const bytes = readFileSync(new URL('../../public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
  const api = new IfcAPI();
  const meshes: MeshData[] = [];
  try {
    api.setComputeGeometryHashes(0.001);
    const pre: PrePass = api.buildPrePassOnce(bytes);
    const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale,
      pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      const volumes = new Map(Array.from(collection.geometryHashIds, (id, index) => [id, collection.geometryVolumeValues[index]]));
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        assert.ok(mesh);
        try {
          const color = mesh.color, origin = mesh.origin;
          meshes.push({ expressId: mesh.expressId, positions: mesh.positions, normals: mesh.normals, indices: mesh.indices,
            color: [color[0], color[1], color[2], color[3]], origin: [origin[0], origin[1], origin[2]],
            geometryVolume: volumes.get(mesh.expressId) });
        } finally { mesh.free(); }
      }
    } finally { collection.free(); }
  } finally { api.clearPrePassCache(); api.free(); }
  const walls = meshes.filter(mesh => store.entities.getTypeName(mesh.expressId) === 'IfcWall' && (mesh.geometryVolume ?? 0) > 0);
  assert.ok(walls.length > 0, 'authored Bonsai sample has a proved wall mesh');
  const wall = walls[0];
  const geometry: GeometryResult = { meshes, totalTriangles: meshes.reduce((n,m) => n+m.indices.length/3,0),
    totalVertices: meshes.reduce((n,m) => n+m.positions.length/3,0), coordinateInfo: {
      originShift: { x:0,y:0,z:0 }, originalBounds: { min:{x:0,y:0,z:0},max:{x:10,y:10,z:10} },
      shiftedBounds: { min:{x:0,y:0,z:0},max:{x:10,y:10,z:10} }, hasLargeCoordinates:false } };
  const zoneSet: ZoneSet = { id:'native-zones', name:'Native Bonsai sections', visible:true, createdAt:0, updatedAt:0,
    zones:[{id:'whole',name:'Whole building', center:[0,0,0],size:[100,100,100],rotationY:0}] };
  useViewerStore.setState({ models:new Map([['bonsai',{...fixtureModel('bonsai'),ifcDataStore:store,geometryResult:geometry}]]),
    activeModelId:'bonsai', ifcDataStore:store, geometryResult:geometry, mutationViews:new Map(), zoneSets:[zoneSet],
    zoneApportionment:new Map(), zoneAssignments:new Map([[wall.expressId,{[zoneSet.id]:{
      zoneId:'whole',zoneName:'Whole building',straddles:false,touchedZoneIds:['whole'] }}]]) });
  return { store, meshes, walls, wall, zoneSet, geometry };
}
