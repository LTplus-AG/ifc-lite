/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { StepExporter } from '@ifc-lite/export';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import type { FlowDocument } from '@ifc-lite/flow';
import type { LoadedModel } from '../context.js';
import { AnchorEntityReader } from '../../../create/src/in-store/resolve-anchor.js';
import { asRef, refList } from '../../../create/src/in-store/style-entity-reader.js';
import { liveToolSession } from '../test/live-tool-session.js';

const wasm = new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url), available = existsSync(wasm);
beforeAll(async () => {
  if (!available) { console.warn('Run pnpm build:wasm for native public flow creation controls'); return; }
  const runtime = await import('@ifc-lite/wasm');
  runtime.initSync({ module: readFileSync(wasm) });
});
const kinds = ['wall', 'slab', 'column', 'beam', 'stair', 'railing'] as const;
type Kind = typeof kinds[number];

/** Real registry wiring: source storey -> spec -> tracked SDK creation. */
function creationFlow(kind: Kind): FlowDocument {
  const nodes: FlowDocument['nodes'][number][] = [
    { id:'storeys', type:'model.byType', params:{type:'IfcBuildingStorey'} },
    { id:'first', type:'core.first' },
    { id:'spec', type:`element.${kind}`, params: kind === 'railing'
      ? { Path:[[20,20,0],[24,20,0],[24,23,0]], Height:1.1, PostSpacing:1, Name:`Flow ${kind}` }
      : kind === 'stair' ? { NumberOfRisers:10, RiserHeight:.18, TreadLength:.28, Width:1.2, Name:`Flow ${kind}` }
      : { name:`Flow ${kind}` } },
    { id:'made', type:'model.addElement' },
  ];
  const edges: FlowDocument['edges'][number][] = [
    { from:['storeys','entities'], to:['first','items'] },
    { from:['first','item'], to:['spec','storey'] },
    { from:['spec','spec'], to:['made','spec'] },
  ];
  const addPoint = (id: string, values: readonly number[], port: string) => {
    nodes.push({id,type:'geometry.point'});
    for (const [axis,value] of values.entries()) {
      const key = `${id}-${axis}`, coordinate = ['x','y','z'][axis];
      nodes.push({id:key,type:'core.number',params:{value}});
      edges.push({from:[key,'value'],to:[id,coordinate]});
    }
    edges.push({from:[id,'point'],to:['spec',port]});
  };
  if (kind === 'wall' || kind === 'beam') {
    addPoint('start',[20,20,kind === 'beam' ? 3 : 0],'start');
    addPoint('end',[24,20,kind === 'beam' ? 3 : 0],'end');
  } else if (kind !== 'railing') addPoint('position',[20,20,0],kind === 'stair' ? 'Position' : 'position');
  return {flowVersion:1,id:`6232-public-${kind}`,name:`Public ${kind}`,capabilities:['model.read','model.create'],inputs:[],outputs:[{nodeId:'made',port:'entity',label:'Created'}],nodes,edges};
}

const exportModel = (model: LoadedModel) => new StepExporter(model.store, model.backend.getMutationView() ?? undefined).export({schema:model.store.schemaVersion ?? 'IFC4',applyMutations:true,timeStamp:'2026-10-03T00:00:00'}).content;
async function snapshot(model: LoadedModel) {
  const view = model.backend.ensureEditor().getMutationView(), source = await new IfcParser().parseColumnar(exportModel(model).slice().buffer as ArrayBuffer,{disableWorkerScan:true});
  const extractor = new EntityExtractor(source.source);
  return structuredClone({graph:[...source.entityIndex.byId].map(([id,location])=>({id,...extractor.extractEntity(location)!})).sort((a,b)=>a.id-b.id),records:view.getNewEntities(),journal:view.getMutations(),next:view.peekNextExpressId()});
}
/** Native oracle independent of Flow's builders: real indices and vertex bounds. */
async function nativeMeshes(model: LoadedModel) {
  const processor = new GeometryProcessor({enableInstancing:false});
  try {
    await processor.init();
    const {meshes} = await processor.process(exportModel(model));
    return meshes.map(mesh=> {
      const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
      for(let i=0;i<mesh.positions.length;i++) { const axis=i%3,value=mesh.positions[i]+(mesh.origin?.[axis] ?? 0); expect(Number.isFinite(value)).toBe(true);lo[axis]=Math.min(lo[axis],value);hi[axis]=Math.max(hi[axis],value); }
      // Compare actual before/Undo native output, never a committed byte-layout snapshot.
      const fingerprint = createHash('sha256');
      for (const array of [mesh.positions, mesh.indices, mesh.normals]) fingerprint.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
      fingerprint.update(JSON.stringify({ origin: mesh.origin ?? [0,0,0], color: mesh.color }));
      return {id:mesh.expressId,vertices:mesh.positions.length/3,triangles:mesh.indices.length/3,lo,hi,hash:fingerprint.digest('hex')};
    }).sort((a,b)=>a.id-b.id || a.triangles-b.triangles);
  } finally { processor.dispose(); }
}

for (const count of [1,2]) for (const kind of kinds) it.skipIf(!available)(`#6232 public run_flow ${kind} creates real geometry and one Undo restores the complete Bonsai graph (${count} models)`,async()=>{
  const {registry,call}=await liveToolSession(count),target=count===1?'alpha':'beta',model=registry.get(target)!;
  const peer=count===2?registry.get('alpha')!:null;
  try {
    // Keep an earlier real overlay write: Undo must preserve it and source products.
    expect((await call('entity_set_attribute',{model_id:target,express_id:1222,attribute:'Name',value:'Prior public edit'})).isError).not.toBe(true);
    const before=await snapshot(model),peerBefore=peer?await snapshot(peer):null,nativeBefore=await nativeMeshes(model);
    const flow=creationFlow(kind),created=await call('run_flow',{model_id:target,flow});
    expect(created.isError,JSON.stringify(created)).not.toBe(true);
    expect(created.structuredContent?.ok,JSON.stringify(created)).toBe(true);
    const outputs=created.structuredContent?.outputs as Array<{key:string;data:{modelId:string;expressId:number;globalId:string}}>;
    const ref=outputs.find(output=>output.key==='made.entity')!.data;
    expect(ref.modelId).toBe(target);expect(ref.expressId).toBeGreaterThan(0);
    const view=model.backend.ensureEditor().getMutationView(),reader=new AnchorEntityReader(model.store,view),product=reader.entity(ref.expressId)!;
    expect(product.type.toUpperCase()).toBe(`IFC${kind.toUpperCase()}`);
    expect(product.attributes[0]).toBe(ref.globalId);
    expect(product.attributes[2]).toBe(`Flow ${kind}`);
    const after=await snapshot(model),meshes=await nativeMeshes(model);
    expect(after.records.length).toBeGreaterThan(before.records.length);
    expect(after.journal.length).toBeGreaterThan(before.journal.length);
    const containment=[...reader.ids('IFCRELCONTAINEDINSPATIALSTRUCTURE')].map(id=>reader.entity(id)!).find(rel=>refList(rel.attributes[4]).includes(ref.expressId));
    expect(asRef(containment?.attributes[5])).toBe(42);
    let meshId=ref.expressId;
    if(kind==='stair') {
      const aggregate=[...reader.ids('IFCRELAGGREGATES')].map(id=>reader.entity(id)!).find(rel=>asRef(rel.attributes[4])===ref.expressId)!;
      const flights=refList(aggregate.attributes[5]);expect(flights).toHaveLength(1);
      meshId=flights[0];expect(reader.entity(meshId)?.type.toUpperCase()).toBe('IFCSTAIRFLIGHT');
    }
    const generated=meshes.filter(mesh=>mesh.id===meshId);expect(generated.length).toBeGreaterThan(0);
    expect(generated.reduce((total,mesh)=>total+mesh.triangles,0)).toBeGreaterThan(0);
    expect(generated.every(mesh=>mesh.vertices>0 && mesh.hi.some((value,axis)=>value>mesh.lo[axis]))).toBe(true);
    // Fresh per-call tracking must refuse a colliding live GlobalId atomically.
    const duplicate=await call('run_flow',{model_id:target,flow});expect(duplicate.structuredContent?.ok).toBe(false);
    expect(await snapshot(model)).toEqual(after);
    expect((await call('mutation_undo',{model_id:target,n:1})).isError).not.toBe(true);
    expect(await snapshot(model)).toEqual({...before,next:after.next}); // IDs stay monotonic after Undo.
    expect(new AnchorEntityReader(model.store,view).entity(ref.expressId)).toBeNull();
    if(kind==='stair') expect(new AnchorEntityReader(model.store,view).entity(meshId)).toBeNull();
    expect(await nativeMeshes(model)).toEqual(nativeBefore);
    if(peer) expect(await snapshot(peer)).toEqual(peerBefore);
  } finally {for(const loaded of registry.list()) loaded.backend.dispose();}
},30_000);
