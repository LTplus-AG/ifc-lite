/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as arrow from 'apache-arrow';
import { readParquet } from 'parquet-wasm';
import { splitMeshByZones } from '@ifc-lite/wasm';
import { seedZoneExport } from '@/test/zone-export-fixture';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render';
import { ActivityTrayList } from '@/components/viewer/activity/ActivityTrayList';
import { activityCanceller, useActivityJournal } from '@/lib/activity/activity-journal';
import { exportZoneGeometry } from './useZoneGeometrySplit';
import { exportZoneTable } from './useZoneTableExport';
import { runZoneSplitBatch } from '@/workers/zoneSplit.worker';
import type { ZoneSet } from '@/lib/zones';

const jobs = () => useActivityJournal.getState().jobs;
function job() {
  const row = jobs()[0];
  assert.ok(row, 'actual native export registered its Activity row');
  return row;
}
beforeEach(() => useActivityJournal.setState({ jobs: [] }));
afterEach(cleanup);

function emittedGlb(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0,true), 0x46546c67, 'actual GLB magic');
  assert.equal(view.getUint32(8,true), bytes.length);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20,20+view.getUint32(12,true)))) as {
    meshes: Array<{primitives:Array<{attributes:{POSITION:number};indices:number}>}>;
    accessors:Array<{count:number;min?:number[];max?:number[]}>;
  };
}
function cutZones(f: Awaited<ReturnType<typeof seedZoneExport>>): ZoneSet {
  const p=f.wall.positions, o=f.wall.origin ?? [0,0,0];
  const min=[Infinity,Infinity,Infinity], max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<p.length;i+=3)for(let a=0;a<3;a++){min[a]=Math.min(min[a],p[i+a]+o[a]);max[a]=Math.max(max[a],p[i+a]+o[a]);}
  const center:[number,number,number]=[(min[0]+max[0])/2,(min[1]+max[1])/2,(min[2]+max[2])/2];
  const half=(max[0]-min[0])/2;
  const zones:ZoneSet={...f.zoneSet,zones:[
    {id:'left',name:'Left cut',center:[center[0]-half/2,center[1],center[2]],size:[half,100,100],rotationY:0},
    {id:'right',name:'Right cut',center:[center[0]+half/2,center[1],center[2]],size:[half,100,100],rotationY:0}]};
  useViewerStore.setState({zoneSets:[zones],zoneAssignments:new Map([[f.wall.expressId,{[zones.id]:{
    zoneId:'left',zoneName:'Left cut',straddles:true,touchedZoneIds:['left','right']}}]])});
  return zones;
}

test('real Bonsai wall GLB publication owns a running row and completes without invented Cancel (#7142)', async t=>{
  if(!ensureWasm(t))return;
  const f=await seedZoneExport();let artifact:Uint8Array|undefined;
  render(<ActivityTrayList/>);
  const run=exportZoneGeometry(f.zoneSet,0,{split:splitMeshByZones,meshPieces:id=>f.meshes.filter(m=>m.expressId===id),emit:bytes=>{artifact=bytes;}});
  assert.equal(jobs().length,1);assert.equal(job().outcome,'running');
  assert.equal(activityCanceller(job().id),null);
  assert.equal(document.querySelector('button[aria-label="Cancel Export zone geometry"]'),null);
  const result=await run;assert.ok(result.ok);assert.equal(result.summary.whole,1);assert.equal(job().outcome,'completed');
  assert.ok(artifact);const glb=emittedGlb(artifact);
  assert.equal(glb.accessors[glb.meshes[0].primitives[0].attributes.POSITION].count,f.wall.positions.length/3);
  assert.equal(glb.accessors[glb.meshes[0].primitives[0].indices].count,f.wall.indices.length);
});

test('real WASM cut retains native progress, background lease and exact row through a busy refusal (#7142)',async t=>{
  if(!ensureWasm(t))return;
  const f=await seedZoneExport(),zones=cutZones(f);let release=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});let artifact:Uint8Array|undefined;
  const nativeProgress:Array<[number,number]>=[];
  render(<ActivityTrayList/>);
  const run=exportZoneGeometry(zones,0,{split:splitMeshByZones,meshPieces:id=>f.meshes.filter(m=>m.expressId===id),
    batch:async(request,progress)=>{await gate;return runZoneSplitBatch(splitMeshByZones,request,progress);},
    onProgress:(done,total)=>nativeProgress.push([done,total]),emit:bytes=>{artifact=bytes;}});
  let id='';
  try {
    assert.equal(jobs().length,1);id=job().id;
    cleanup(); // Native geometry authority lives outside the closed panel/tray.
    const busy=await exportZoneGeometry(zones,1,{split:splitMeshByZones});
    assert.deepEqual(busy,{ok:false,reason:'busy'});assert.equal(jobs().length,1);assert.equal(job().outcome,'running');
  } finally { release(); await run; }
  const result=await run;assert.ok(result.ok);assert.equal(result.summary.cut,1);
  assert.equal(job().id,id);assert.equal(job().outcome,'completed');
  assert.ok(nativeProgress.length>0);assert.deepEqual(nativeProgress.at(-1),[1,1]);
  assert.ok(artifact);const glb=emittedGlb(artifact);assert.ok(glb.accessors[glb.meshes[0].primitives[0].indices].count>0);
  const positions=glb.accessors[glb.meshes[0].primitives[0].attributes.POSITION];
  assert.ok(positions.min && positions.max);
  const zone=zones.zones[0];
  assert.ok(positions.min[0]>=zone.center[0]-zone.size[0]/2-1e-5, 'actual GLB vertices stay in the selected cut');
  assert.ok(positions.max[0]<=zone.center[0]+zone.size[0]/2+1e-5, 'the peer cut is not published in this artifact');
  assert.ok((result.summary.volumeM3??0)>0);assert.ok((result.summary.volumeM3??Infinity)<(f.wall.geometryVolume??0));
});

test('missing binding and absent zone preflight produce no fictitious completed export (#7142)',async t=>{
  if(!ensureWasm(t))return;
  const f=await seedZoneExport();
  assert.deepEqual(await exportZoneGeometry(f.zoneSet,0,{split:undefined}),{ok:false,reason:'no-binding'});
  assert.deepEqual(await exportZoneGeometry(f.zoneSet,99,{split:splitMeshByZones}),{ok:false,reason:'empty-zone'});
  assert.equal(jobs().length,0);
});

test('native geometry absence is Failed and publishes no empty GLB (#7142)',async t=>{
  if(!ensureWasm(t))return;
  const f=await seedZoneExport();let emitted=0;
  const result=await exportZoneGeometry(f.zoneSet,0,{split:splitMeshByZones,meshPieces:()=>null,emit:()=>{emitted++;}});
  assert.deepEqual(result,{ok:false,reason:'no-geometry'});assert.equal(emitted,0);
  assert.equal(job().outcome,'failed');assert.equal(job().detailKey,'zonesPanel.exportNothingToExport');
});

test('published real GLB with released peer geometry is Partial and retains native coverage counts (#7142)',async t=>{
  if(!ensureWasm(t))return;
  const f=await seedZoneExport(),peer=f.meshes.find(m=>m.expressId!==f.wall.expressId);assert.ok(peer);
  const assignments=new Map(useViewerStore.getState().zoneAssignments);
  assignments.set(peer.expressId,{[f.zoneSet.id]:{zoneId:'whole',zoneName:'Whole building',straddles:false,touchedZoneIds:['whole']}});
  useViewerStore.setState({zoneAssignments:assignments});let artifact:Uint8Array|undefined;
  const result=await exportZoneGeometry(f.zoneSet,0,{split:splitMeshByZones,
    meshPieces:id=>id===peer.expressId?null:f.meshes.filter(m=>m.expressId===id),emit:bytes=>{artifact=bytes;}});
  assert.ok(result.ok);assert.equal(result.summary.whole,1);assert.equal(result.summary.noGeometry,1);
  assert.equal(job().outcome,'partial');assert.match(job().detail??'',/1 whole.*0 refused and 1 without geometry/);
  assert.ok(artifact);emittedGlb(artifact);
});

test('real GLB download failure releases the native lease and records only its invocation as Failed (#7142)',async t=>{
  if(!ensureWasm(t))return;
  const f=await seedZoneExport();const deps={split:splitMeshByZones,meshPieces:(id:number)=>f.meshes.filter(m=>m.expressId===id)};
  await assert.rejects(exportZoneGeometry(f.zoneSet,0,{...deps,emit:()=>{throw new Error('Browser refused zone GLB');}}),/Browser refused zone GLB/);
  const firstId=job().id;assert.equal(job().outcome,'failed');
  let artifact:Uint8Array|undefined;const retry=await exportZoneGeometry(f.zoneSet,0,{...deps,emit:bytes=>{artifact=bytes;}});
  assert.ok(retry.ok);assert.ok(artifact);assert.equal(jobs().length,2);
  assert.equal(jobs().find(job=>job.id===firstId)?.outcome,'failed');assert.equal(jobs().at(-1)?.outcome,'completed');
});

test('native CSV quantities preserve authored identity and real mesh volume with Completed outcome (#7142)',async t=>{
  if(!ensureWasm(t))return;
  const f=await seedZoneExport();let csv='';
  const result=await exportZoneTable(f.zoneSet,'mesh','csv',bytes=>{csv=new TextDecoder().decode(bytes);});
  assert.equal(result.blocked,null);assert.equal(result.unmeasured,0);assert.equal(job().outcome,'completed');
  assert.ok(csv.includes(f.store.entities.getGlobalId(f.wall.expressId)));
  assert.match(csv,/IfcWall/);assert.match(csv,/Whole building/);assert.ok(result.bytes>0);
});

test('native CSV without declared quantity stays Partial with its actual per-row reason (#7142)',async t=>{
  if(!ensureWasm(t))return;
  const f=await seedZoneExport();let csv='';
  const result=await exportZoneTable(f.zoneSet,'net','csv',bytes=>{csv=new TextDecoder().decode(bytes);});
  assert.ok(result.unmeasured>0);assert.equal(job().outcome,'partial');
  assert.match(job().detail??'',/unmeasured quantity/);assert.match(csv,/the model declares no quantity on this basis/);
  assert.ok(csv.includes(f.store.entities.getGlobalId(f.wall.expressId)));
});

test('native no-members table and failed publication keep honest outcomes and cleanup (#7142)',async t=>{
  if(!ensureWasm(t))return;
  const f=await seedZoneExport();const assigned=useViewerStore.getState().zoneAssignments;
  useViewerStore.setState({zoneAssignments:new Map()});let emitted=0;
  const empty=await exportZoneTable(f.zoneSet,'mesh','csv',()=>{emitted++;});
  assert.equal(empty.blocked,'no-members');assert.equal(emitted,0);assert.equal(jobs().length,0);
  useViewerStore.setState({zoneAssignments:assigned});
  await assert.rejects(exportZoneTable(f.zoneSet,'mesh','csv',()=>{throw new Error('Browser refused zone table');}),/Browser refused zone table/);
  assert.equal(job().outcome,'failed');assert.equal(job().detail,'Browser refused zone table');assert.equal(activityCanceller(job().id),null);
});


test('native Parquet publication round-trips authored identity and actual mesh quantity (#7142)',async t=>{
  if(!ensureWasm(t))return;
  const f=await seedZoneExport();let artifact:Uint8Array|undefined;
  const result=await exportZoneTable(f.zoneSet,'mesh','parquet',bytes=>{artifact=bytes;});
  assert.ok(artifact);assert.match(result.filename,/\.parquet$/);
  const table=arrow.tableFromIPC(readParquet(artifact).intoIPCStream());
  assert.equal(table.numRows,1);
  assert.equal(table.getChild('GlobalId')?.get(0),f.store.entities.getGlobalId(f.wall.expressId));
  assert.equal(table.getChild('ExpressId')?.get(0),f.wall.expressId);
  assert.equal(table.getChild('VolumeM3')?.get(0),f.wall.geometryVolume);
  assert.equal(job().outcome,'completed');assert.equal(activityCanceller(job().id),null);
});

test('native unproved straddler refusal survives as Partial beside published real wall geometry (#7142)',async t=>{
  if(!ensureWasm(t))return;
  const f=await seedZoneExport(),peer=f.meshes.find(m=>m.expressId!==f.wall.expressId);assert.ok(peer);
  const assignments=new Map(useViewerStore.getState().zoneAssignments);
  assignments.set(peer.expressId,{[f.zoneSet.id]:{zoneId:'whole',zoneName:'Whole building',straddles:true,touchedZoneIds:['whole']}});
  const unproved={...f.geometry,meshes:f.meshes.map(mesh=>mesh.expressId===peer.expressId?{...mesh,geometryVolume:undefined}:mesh)};
  const models=new Map(useViewerStore.getState().models),model=models.get('bonsai');assert.ok(model);
  models.set('bonsai',{...model,geometryResult:unproved});
  useViewerStore.setState({models,geometryResult:unproved,zoneAssignments:assignments});let artifact:Uint8Array|undefined;
  const result=await exportZoneGeometry(f.zoneSet,0,{split:splitMeshByZones,
    meshPieces:id=>f.meshes.filter(mesh=>mesh.expressId===id),emit:bytes=>{artifact=bytes;}});
  assert.ok(result.ok);assert.equal(result.summary.refused,1);assert.equal(job().outcome,'partial');
  assert.match(job().detail??'',/1 refused and 0 without geometry/);assert.ok(artifact);emittedGlb(artifact);
});
