/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initSync } from '@ifc-lite/wasm';
import { IfcParser, EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { Renderer } from '@ifc-lite/renderer';
import { GeometryProcessor, type GeometryResult } from '@ifc-lite/geometry';
import { renderFrameWorldOffset, viewerToIfcAxes } from '@ifc-lite/geometry/world-frame';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { clearGlobalRefs, setGlobalRendererRef } from '@/hooks/useBCF';
import { render, click, cleanup, waitFor } from '@/test/render';
import { ExportDialog } from '@/components/viewer/ExportDialog';
import { exportModelStep } from './model-step-export';

const textured = readFileSync(new URL('../../../../../rust/export/tests/fixtures/section_textured.ifc', import.meta.url), 'utf8');
const downloads: Blob[] = [];

beforeEach(() => {
  initSync({ module: new Uint8Array(readFileSync(new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url))) });
  useViewerStore.getState().resetViewerState();
  downloads.length = 0;
  mock.method(URL, 'createObjectURL', (object: Blob | MediaSource) => {
    assert.ok(object instanceof Blob);
    downloads.push(object);
    return 'blob:section-safety';
  });
  mock.method(URL, 'revokeObjectURL', () => {});
  mock.method(HTMLAnchorElement.prototype, 'click', () => {});
  setGlobalRendererRef({ current: { getCamera: () => ({ getSceneBounds: () => ({ min: {x:-5,y:-4,z:-3}, max: {x:5,y:4,z:3} }) }) } as unknown as Renderer });
});
afterEach(() => { cleanup(); mock.restoreAll(); clearGlobalRefs(); useViewerStore.getState().resetViewerState(); });

function stepBytes(content: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
}
async function parse(source: string) {
  return new IfcParser().parseColumnar(stepBytes(source).buffer, { disableWorkerScan: true });
}
function enableSection() {
  const state = useViewerStore.getState();
  useViewerStore.setState({ sectionPlane: { ...state.sectionPlane, enabled: true, flipped: false,
    custom: { normal: [1,0,0], distance: 0.5, pickedAt: [0,0,0], tangent: [0,1,0], bitangent: [0,0,1] } } });
}
function button(label: string) {
  const found = [...document.querySelectorAll('button')].find(el => el.textContent?.trim() === label);
  assert.ok(found, `dialog action ${label} is mounted`);
  return found;
}
function visibleOnly() {
  const label = [...document.querySelectorAll('label')].find(el => el.textContent === 'Export Visible Only');
  const toggle = label?.parentElement?.parentElement?.querySelector('[role="switch"]');
  assert.ok(toggle);
  click(toggle);
  assert.ok(document.getElementById('trim-section-export'));
}

// #7711: use an actual textured STEP, real WASM, serializer and dialog. The
// failure must reach the user and must not hand back an uncut download.
test('#7711 textured crossing refuses the actual download; inside serialization preserves texture and UV attachments', async () => {
  const store = await parse(textured);
  useViewerStore.setState(fixtureModels({ ...fixtureModel('m'), ifcDataStore: store, schemaVersion: 'IFC4', maxExpressId: 85 }));
  const inside = await exportModelStep({ modelId: 'm', dataStore: store, options: { schema: 'IFC4' }, scheduleState: null,
    section: { planes: [{normal:[1,0,0],offset:2}] } });
  const reopened = await new IfcParser().parseColumnar(stepBytes(inside.content).buffer, { disableWorkerScan: true });
  assert.equal(reopened.entities.getGlobalId(50), store.entities.getGlobalId(50));
  const extractor = new EntityExtractor(reopened.source!);
  const args = (id: number) => extractor.extractEntity(reopened.entityIndex.byId.get(id)!)?.attributes;
  assert.equal(args(80)?.[5], 'textures/wood.jpg');
  assert.deepEqual(args(81)?.[0], [[0,0],[1,0],[1,1],[0,1]]);
  assert.equal(args(82)?.[1], 42, 'UV map still targets the authored tessellation');
  assert.deepEqual(args(85)?.[0], [80]);
  enableSection();
  render(<ExportDialog surface="ribbon" />);
  click(button('Export IFC'));
  visibleOnly();
  click(button('Export'));
  await waitFor(() => document.body.textContent?.includes('cannot trim textured product #50') === true, 'textured trimming did not report its refusal');
  assert.equal(downloads.length, 0, 'refused texture mapping must never download a plain-colour or uncut substitute');
});

async function geometry(bytes: Uint8Array): Promise<GeometryResult> {
  const processor = new GeometryProcessor();
  try { await processor.init(); return await processor.process(bytes); }
  finally { processor.dispose(); }
}

// Real unsupported-UV IfcTextureMap attaches to a polygonal IfcFace. There is
// no IndexedTriangleTextureMap and no StyledItem in the inverse-only source.
test('#7711 inverse-only, mapped inverse-only and styled-only textures refuse without decoded mesh UVs', async () => {
  const inverse = readFileSync(new URL('../../../../../rust/export/tests/fixtures/section_inverse_texture.ifc', import.meta.url), 'utf8');
  const plain = inverse.replace('#82=IFCTEXTUREMAP((#80),(#81,#86,#87,#88),#42);', '');
  const styled = plain.replace('#80=IFCIMAGETEXTURE', "#83=IFCSTYLEDITEM(#42,(#84),$);\n#84=IFCSURFACESTYLE('Texture',.BOTH.,(#85));\n#85=IFCSURFACESTYLEWITHTEXTURES((#80));\n#80=IFCIMAGETEXTURE");
  const mapped = inverse.replace("#44=IFCSHAPEREPRESENTATION(#10,'Body','SurfaceModel',(#46));", `
#104=IFCSHAPEREPRESENTATION(#10,'Body','SurfaceModel',(#46));
#105=IFCREPRESENTATIONMAP(#11,#104);
#106=IFCCARTESIANPOINT((0.25,0.,0.));
#107=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#106,1.,$);
#108=IFCMAPPEDITEM(#105,#107);
#44=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',(#108));`);
  const section = { planes: [{normal:[1,0,0] as const,offset:0.5}] };
  const plainResult = await exportModelStep({ modelId:'m', dataStore:await parse(plain), options:{schema:'IFC4'}, scheduleState:null, section });
  const plainStore = await new IfcParser().parseColumnar(stepBytes(plainResult.content).buffer, {disableWorkerScan:true});
  assert.equal(plainStore.entityIndex.byType.get('IFCTRIANGULATEDFACESET')?.length, 1, 'the same untextured face is genuinely croppable');
  for (const [label, source] of [['inverse-only',inverse],['mapped inverse-only',mapped],['styled-only',styled]]) {
    const store = await parse(source);
    assert.equal(store.entityIndex.byType.get('IFCINDEXEDTRIANGLETEXTUREMAP')?.length ?? 0, 0, label);
    assert.equal(store.entityIndex.byType.get('IFCSTYLEDITEM')?.length ?? 0, label === 'styled-only' ? 1 : 0, label);
    assert.equal(store.entityIndex.byType.get('IFCTEXTUREMAP')?.length ?? 0, label === 'styled-only' ? 0 : 1, label);
    const original = await geometry(new TextEncoder().encode(source));
    const parts = original.meshes.filter(part => part.expressId === 50);
    assert.ok(parts.length > 0, `${label}: actual parsed geometry must survive`);
    assert.ok(parts.every(part => !part.uvs && !part.texture && !part.textureRef), `${label}: source discovery must be the only texture refusal route`);
    const input = { modelId:'m', dataStore:store, options:{schema:'IFC4' as const}, scheduleState:null };
    const inside = await exportModelStep({...input,section:{planes:[{normal:[1,0,0],offset:2}]}});
    const reopened = await new IfcParser().parseColumnar(stepBytes(inside.content).buffer, {disableWorkerScan:true});
    assert.equal(reopened.entities.getGlobalId(50), store.entities.getGlobalId(50), label);
    assert.equal(reopened.entityIndex.byType.get('IFCTEXTUREMAP')?.length ?? 0, label === 'styled-only' ? 0 : 1, label);
    assert.equal(reopened.entityIndex.byType.get('IFCSTYLEDITEM')?.length ?? 0, label === 'styled-only' ? 1 : 0, label);
    if (label === 'mapped inverse-only') assert.equal(reopened.entityIndex.byType.get('IFCMAPPEDITEM')?.length, 1, 'the map stays attached to the mapped source face');
    await assert.rejects(exportModelStep({...input,section}), /cannot trim textured product #50/, label);
  }
});

/** Reopen actual downloaded geometry through the canonical mesher. Restore its
 * recorded frame with the shared helpers; never apply ObjectPlacement twice. */
function worldMeshPoints(result: GeometryResult, expressId: number): [number, number, number][] {
  const offset = renderFrameWorldOffset(result.coordinateInfo);
  const parts = result.meshes.filter(mesh => mesh.expressId === expressId && (mesh.geometryClass ?? 0) === 0);
  assert.ok(parts.length > 0, `reopened product #${expressId} must really mesh`);
  const points: [number, number, number][] = [];
  for (const mesh of parts) {
    const origin = mesh.origin ?? [0,0,0];
    for (const index of mesh.indices) {
      const i = index * 3;
      const p = viewerToIfcAxes({x:mesh.positions[i]+origin[0],y:mesh.positions[i+1]+origin[1],z:mesh.positions[i+2]+origin[2]});
      points.push([p.x+offset.x,p.y+offset.y,p.z+offset.z]);
    }
  }
  assert.ok(points.length >= 3);
  return points;
}

function federationSource(millimetres: boolean) {
  const scale = millimetres ? 1000 : 1;
  const prefix = millimetres ? '1' : '0';
  const real = (value: number) => Number.isInteger(value) ? `${value}.` : String(value);
  return textured.split('\n').filter(line => !/^#8[0-5]=/.test(line)).join('\n')
    .replace("$,.METRE.", `${millimetres ? '.MILLI.' : '$'},.METRE.`)
    // Nonidentity AUTHORED placement, independent of the workspace move below:
    // IFC world = (0.25 - localY, -1 + localX, 2), in metres for BOTH sources.
    .replace('#22=IFCLOCALPLACEMENT($,#11);', `#23=IFCCARTESIANPOINT((${real(0.25*scale)},${real(-scale)},${real(2*scale)}));
#24=IFCAXIS2PLACEMENT3D(#23,$,#25);
#25=IFCDIRECTION((0.,1.,0.));
#22=IFCLOCALPLACEMENT($,#24);`)
    .replace("#40=IFCCARTESIANPOINTLIST3D(((0.,-1.,0.),(1.,-1.,0.),(1.,1.,0.),(0.,1.,0.)));",
      `#40=IFCCARTESIANPOINTLIST3D(((0.,-${scale}.,0.),(${scale}.,-${scale}.,0.),(${scale}.,${scale}.,0.),(0.,${scale}.,0.)));`)
    .replace("#50=IFCSLAB('0M7tQ9Jbj1BAeHd7rqnDmR',$,'Textured surface',$,$,#22,#45,$,.FLOOR.);",
      [50,51,52].map((id, i) => `#${id}=IFCSLAB('${prefix}M7tQ9Jbj1BAeHd7rqnDm${['R','S','T'][i]}',$,'Product ${id}',$,$,#22,#45,$,.FLOOR.);`).join('\n'));
}

/** Read the actual reopened replacement; no mesh, crop or merge mocks. */
function replacementPoints(store: IfcDataStore, id: number): [number, number, number][] {
  const extractor = new EntityExtractor(store.source!);
  const args = (id: number) => extractor.extractEntity(store.entityIndex.byId.get(id)!)?.attributes;
  const shapeId = args(id)?.[6]; assert.equal(typeof shapeId, 'number');
  assert.ok(typeof shapeId === 'number');
  const reps = args(shapeId)?.[2]; assert.ok(Array.isArray(reps));
  const repId = reps[0]; assert.ok(typeof repId === 'number');
  const items = args(repId)?.[3]; assert.ok(Array.isArray(items));
  const itemId = items[0]; assert.ok(typeof itemId === 'number');
  // Representation items live in the complete source index; the compact
  // product metadata table does not contain every geometry record.
  const item = store.entityIndex.byId.get(itemId);
  assert.ok(item, 'downloaded replacement item must exist in the reopened source');
  assert.equal(item.type, 'IFCTRIANGULATEDFACESET');
  const pointsId = args(itemId)?.[0]; assert.ok(typeof pointsId === 'number');
  const coords = args(pointsId)?.[0]; assert.ok(Array.isArray(coords));
  return coords.map((p): [number, number, number] => {
    assert.ok(Array.isArray(p));
    const [x,y,z] = p;
    assert.ok(typeof x === 'number' && typeof y === 'number' && typeof z === 'number');
    return [x,y,z];
  });
}

// #7711: coefficients alone do not prove the dialog crops each source before
// unit normalization/ID remap. Inspect the actual merged download instead.
test('#7711 merged dialog download preserves authored placement in reopened world meshes with mixed units and workspace crops', async () => {
  const metres = await parse(federationSource(false)), millimetres = await parse(federationSource(true));
  useViewerStore.setState({ ...fixtureModels(
    { ...fixtureModel('m'), ifcDataStore: metres, schemaVersion: 'IFC4', maxExpressId: 85, loadedAt: 1 },
    { ...fixtureModel('n', {idOffset:1_000_000}), ifcDataStore: millimetres, schemaVersion: 'IFC4', maxExpressId: 85, loadedAt: 2 },
  ), hiddenEntities: new Set([51,1_000_051]), isolatedEntities: new Set([50,51,1_000_050,1_000_051]) });
  const state = useViewerStore.getState();
  useViewerStore.setState({ modelPlacement: { ...state.modelPlacement, placements: new Map([
    ['n', { translation: [-0.25,0,0], rotation: { angle: Math.PI/2, pivot: [0,0,0] }, locked: false }],
  ]) } });
  enableSection();
  render(<ExportDialog surface="ribbon" />);
  click(button('Export IFC'));
  const scope = document.querySelector('[role="combobox"]'); assert.ok(scope);
  click(scope);
  const merged = [...document.querySelectorAll('[role="option"]')].find(el => el.textContent?.includes('Merged (All Models)'));
  assert.ok(merged); click(merged);
  const units = [...document.querySelectorAll('[role="combobox"]')]
    .find(el => el.textContent?.trim() === 'Keep each unit (separate projects)');
  assert.ok(units, 'mixed-unit handling is mounted');
  click(units);
  const normalize = [...document.querySelectorAll('[role="option"]')]
    .find(el => el.textContent?.trim() === 'Normalize to first model');
  assert.ok(normalize); click(normalize);
  assert.ok(units.textContent?.includes('Normalize to first model'));
  visibleOnly();
  click(button('Export'));
  await waitFor(() => downloads.length === 1, 'merged section export did not download');
  const downloadBytes = new Uint8Array(await downloads[0].arrayBuffer());
  const reopened = await new IfcParser().parseColumnar(new Uint8Array(downloadBytes).buffer, {disableWorkerScan:true});
  // Diagnostic-only: preserve the real failing output and scanner namespace
  // before following its references. Every geometry assertion below remains.
  const evidenceDir = process.env.IFC_LITE_SECTION_EVIDENCE_DIR;
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'merged-download.ifc'), downloadBytes);
    writeFileSync(join(evidenceDir, 'merged-source-index.json'), JSON.stringify({
      byId: Array.from(reopened.entityIndex.byId, ([id, record]) => ({ id, type: record.type,
        byteOffset: record.byteOffset, byteLength: record.byteLength })),
      byType: Array.from(reopened.entityIndex.byType),
      deferredSize: reopened.deferredEntityIndex?.size ?? 0,
    }, null, 2));
  }
  const products = reopened.entityIndex.byType.get('IFCSLAB') ?? [];
  assert.equal(products.length, 2, 'both hidden #51 and non-isolated #52 are omitted in each model');
  const first = products.find(id => reopened.entities.getGlobalId(id) === '0M7tQ9Jbj1BAeHd7rqnDmR');
  const peer = products.find(id => reopened.entities.getGlobalId(id) === '1M7tQ9Jbj1BAeHd7rqnDmR');
  assert.ok(first !== undefined && peer !== undefined && first !== peer, 'merge remaps colliding express IDs and preserves exact product identities');
  const primary = replacementPoints(reopened, first), secondary = replacementPoints(reopened, peer);
  const extent = (points: number[][], axis: number) => [Math.min(...points.map(p => p[axis])), Math.max(...points.map(p => p[axis]))];
  const close = (actual: number[], expected: number[]) => actual.forEach((v, i) => assert.ok(Math.abs(v-expected[i])<1e-6, `${actual} vs ${expected}`));
  // Replacement points are in each product's authored frame, now in metres.
  // The inverse authored placement must be applied when writing replacement
  // vertices, then applied ONCE by the independent reopen mesh pass.
  close(extent(primary,0), [0,1]); close(extent(primary,1), [-0.25,1]);
  close(extent(secondary,0), [0.25,1]); close(extent(secondary,1), [-1,1]);
  const meshed = await geometry(downloadBytes);
  const primaryWorld = worldMeshPoints(meshed, first), peerWorld = worldMeshPoints(meshed, peer);
  close(extent(primaryWorld,0), [-0.75,0.5]); close(extent(primaryWorld,1), [-1,0]); close(extent(primaryWorld,2), [2,2]);
  close(extent(peerWorld,0), [-0.75,1.25]); close(extent(peerWorld,1), [-0.75,0]); close(extent(peerWorld,2), [2,2]);
  // Canonical merge keeps authored source-world coordinates. Workspace heading
  // and translation only choose each source crop: they are NOT baked into IFC.
  assert.ok(primaryWorld.every(p => p[0]<=0.5+1e-6));
  assert.ok(peerWorld.every(p => -p[1]-0.25<=0.5+1e-6));
  const areaXY = (points: number[][]) => {
    let area = 0;
    for (let i=0;i<points.length;i+=3) {
      const [a,b,c] = points.slice(i,i+3);
      area += Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;
    }
    return area;
  };
  close([areaXY(primaryWorld),areaXY(peerWorld)], [1.25,1.5]);
});
