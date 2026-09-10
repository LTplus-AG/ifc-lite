/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { federationRegistry, type Renderer } from '@ifc-lite/renderer';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { AppearancePreviewController } from '../../../../../packages/renderer/src/appearance-preview.js';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { appearanceAssets } from './model-assets.js';
import { appearanceRevision, captureAppearanceSource } from './command.js';
import { AppearancePreviewSession } from './preview.js';
import type { AppearanceSnapshot } from './snapshot.js';
import type { AppearancePlan } from './planner-types.js';
import type { PreparedAssignmentStep } from './assignments/prepare.js';
import { commitAppearanceAssignments } from './coordinated-command.js';

const source = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Command rollback fixture'),'2;1');
FILE_NAME('command.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,(#6),#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#5,$);
#10=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.)));
#11=IFCTRIANGULATEDFACESET(#10,$,.F.,((1,2,3),(1,3,4)),$);
#13=IFCCOLOURRGB($,1.,0.,0.);
#14=IFCSURFACESTYLERENDERING(#13,0.,$,$,$,$,$,$,.NOTDEFINED.);
#15=IFCSURFACESTYLE($,.BOTH.,(#14));
#19=IFCSTYLEDITEM(#11,(#15),$);
#23=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#11));
#24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#25=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000a',$,'Surface',$,$,$,#24,$,.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;`);
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
export async function coordinatedFixture() {
  const data = await new IfcParser().parseColumnar(source.buffer, { disableWorkerScan: true });
  const owner = { kind: 'draft' as const, id: 'coordinator-test' };
  const asset = await appearanceAssets.add(png, { owner });
  const entries = ['a', 'b'].map((modelId, modelIndex) => {
    const idOffset = federationRegistry.registerModel(modelId, 25);
    const globalId = federationRegistry.toGlobalId(modelId, 25);
    const view = new MutablePropertyView(data.properties, modelId), editor = new StoreEditor(data, view);
    const before: MeshData = { expressId: globalId, modelIndex, geometryItemId: federationRegistry.toGlobalId(modelId, 11),
      positions: new Float32Array([0,0,0, 1,0,0, 1,0,-1, 0,0,-1]), normals: new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0]),
      indices: new Uint32Array([0,1,2,0,2,3]), color: [1,0,0,1] };
    before.appearanceSource = { kind: 'canonical-item', indices: before.indices, sourceIndices: before.indices };
    const after: MeshData = { ...before, color: [1,1,1,1], uvs: new Float32Array([0,0,1,0,1,1,0,1]),
      texture: { width: 1, height: 1, repeatS: true, repeatT: true, rgba: new Uint8Array([0,0,255,255]) } };
    const bounds = { min: {x:0,y:0,z:0}, max: {x:1,y:1,z:0} };
    const geometry: GeometryResult = { meshes: [before], totalTriangles: 2, totalVertices: 4,
      coordinateInfo: { originShift: {x:0,y:0,z:0}, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
    const model = { ...fixtureModel(modelId, { idOffset }), modelIndex, maxExpressId: 25, loadState: 'complete' as const, schemaVersion: 'IFC4' as const, loadedAt: 1, ifcDataStore: data, geometryResult: geometry };
    return { modelId, globalId, modelIndex, view, editor, before, after, model, geometry };
  });
  useViewerStore.setState({ models: new Map(entries.map(e => [e.modelId, e.model])), activeModelId: 'a',
    geometryResult: entries[0].geometry, mutationViews: new Map(entries.map(e => [e.modelId, e.view])),
    storeEditors: new Map(entries.map(e => [e.modelId, e.editor])), undoStacks: new Map(), redoStacks: new Map(),
    dirtyModels: new Set(), mutationVersion: 0, collabRoomId: null });
  const snapshots = new Map<string, AppearanceSnapshot>();
  const steps: PreparedAssignmentStep[] = entries.map(e => {
    const revision = appearanceRevision(e.modelId), checkpoint = captureAppearanceSource(e.view), next = e.view.peekNextExpressId();
    snapshots.set(e.modelId, { modelId: e.modelId, revision, schema: 'IFC4', nextExpressId: next, bytes: source,
      productIds: [25], catalog: { sourceRevision: revision, products: [], types: [], missingProductIds: [] }, source: checkpoint,
      validate: () => checkpoint.validate(useViewerStore.getState().mutationViews.get(e.modelId)) });
    const plan: AppearancePlan = { sourceRevision: revision, nextExpressId: next, nextAvailableExpressId: next + 2,
      created: [{ expressId: next, type: 'IfcImageTexture', attributes: [true,true,'DIFFUSE',null,null,asset.exportName] },
        { expressId: next+1, type: 'IfcSurfaceStyleWithTextures', attributes: [[`#${next}`]] }],
      edits: [{ expressId: 15, index: 2, value: [`#${next+1}`] }], removed: [], exclusions: [],
      items: [{ productId: 25, geometryItemId: 11, texCoords: [[0,0],[1,0],[1,1]], texCoordIndex: [[1,2,3]],
        sourceIndices: [0,1,2], targetIndices: [0,1,2], targetVertexCount: 3,
        previewCornerUvs: [0,0,1,0,1,1], targetCornerNormals: [0,0,1,0,0,1,0,0,1] }] };
    return { assignmentId: e.modelId, modelId: e.modelId, plan, assetIds: [asset.id], imageUri: asset.exportName,
      bitmap: { width: 1, height: 1, close() {} } as ImageBitmap };
  });
  type Resource = { released: boolean };
  const scene = new Map(entries.map(e => [e.globalId, { parts: [e.before] as readonly MeshData[], resources: [{ released: false }] as readonly Resource[] }]));
  const resources: Resource[] = [...scene.values()].flatMap(value => [...value.resources]);
  let failInstall: number | undefined, onInstall: (() => void) | undefined;
  const controller = new AppearancePreviewController<Resource>({
    capture: target => scene.get(target.expressId)!,
    stage: parts => { const created = parts.map(() => ({released:false})); resources.push(...created); return created; },
    install: (target, parts, gpu) => { onInstall?.(); scene.set(target.expressId, { parts, resources: gpu });
      if (failInstall === target.expressId) { failInstall = undefined; throw new Error('Scene observer refused after installation'); } },
    release: gpu => { for (const item of gpu) item.released = true; },
  });
  const renderer = { getAppearancePreview: () => controller, requestRender() {}, getScene: () => ({
    getMeshDataPieces: (expressId: number) => scene.get(expressId)?.parts ?? [],
  }) } as unknown as Renderer;
  const groups = new Map(entries.map(e => [e.modelId, [{ globalId: e.globalId, modelIndex: e.modelIndex, parts: [e.after] }]]));
  const preview = new AppearancePreviewSession(renderer);
  const preparation = { steps, snapshots, validate() { for (const snapshot of snapshots.values()) snapshot.validate(); } };
  return { entries, asset, owner, scene, resources, preview, groups, renderer, preparation,
    stage() { preview.stage([...groups.values()].flat()); },
    failInstall(id: number) { failInstall = id; },
    observeInstall(callback: () => void) { onInstall = callback; },
    export(modelId: string) { const content = new StepExporter(data, entries.find(e => e.modelId === modelId)!.view).export({schema:'IFC4',applyMutations:true}).content; return (typeof content === 'string' ? content : new TextDecoder().decode(content)).split('DATA;')[1]; },
    commit: () => commitAppearanceAssignments(preparation, renderer, preview, groups),
  };
}
