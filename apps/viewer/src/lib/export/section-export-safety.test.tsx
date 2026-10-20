/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync } from '@ifc-lite/wasm';
import { IfcParser, EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { Renderer } from '@ifc-lite/renderer';
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
  setGlobalRendererRef({ current: { getCamera: () => ({ getSceneBounds: () => ({ min: {x:-5,y:-4,z:-3}, max: {x:5,y:4,z:3} }) }) } } as unknown as Renderer);
});
afterEach(() => { cleanup(); mock.restoreAll(); clearGlobalRefs(); useViewerStore.getState().resetViewerState(); });

async function parse(source: string) {
  return new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, { disableWorkerScan: true });
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
  const insideBytes = typeof inside.content === 'string' ? new TextEncoder().encode(inside.content) : inside.content;
  const reopened = await new IfcParser().parseColumnar(new Uint8Array(insideBytes).buffer, { disableWorkerScan: true });
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

function federationSource(millimetres: boolean) {
  const scale = millimetres ? 1000 : 1;
  const prefix = millimetres ? '1' : '0';
  return textured.split('\n').filter(line => !/^#8[0-5]=/.test(line)).join('\n')
    .replace("$,.METRE.", `${millimetres ? '.MILLI.' : '$'},.METRE.`)
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
  assert.equal(store.entities.getTypeName(itemId), 'IfcTriangulatedFaceSet');
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
test('#7711 merged dialog download reopens mixed units with placed crops and global hidden/isolation IDs', async () => {
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
  visibleOnly();
  click(button('Export'));
  await waitFor(() => downloads.length === 1, 'merged section export did not download');
  const reopened = await new IfcParser().parseColumnar(await downloads[0].arrayBuffer(), {disableWorkerScan:true});
  const products = reopened.entityIndex.byType.get('IFCSLAB') ?? [];
  assert.equal(products.length, 2, 'both hidden #51 and non-isolated #52 are omitted in each model');
  const first = products.find(id => reopened.entities.getGlobalId(id) === '0M7tQ9Jbj1BAeHd7rqnDmR');
  const peer = products.find(id => reopened.entities.getGlobalId(id) === '1M7tQ9Jbj1BAeHd7rqnDmR');
  assert.ok(first !== undefined && peer !== undefined && first !== peer, 'merge remaps colliding express IDs and preserves exact product identities');
  const primary = replacementPoints(reopened, first), secondary = replacementPoints(reopened, peer);
  const extent = (points: number[][], axis: number) => [Math.min(...points.map(p => p[axis])), Math.max(...points.map(p => p[axis]))];
  const close = (actual: number[], expected: number[]) => actual.forEach((v, i) => assert.ok(Math.abs(v-expected[i])<1e-6, `${actual} vs ${expected}`));
  // The canonical merge retains source placements. In the normalized metre
  // source frame, the peer's visible workspace X is analytically -Y - 0.25.
  close(extent(primary,0), [0,0.5]); close(extent(primary,1), [-1,1]);
  close(extent(secondary,0), [0,1]); close(extent(secondary,1), [-0.75,1]);
  assert.ok(primary.every(p => p[0]<=0.5+1e-6));
  assert.ok(secondary.every(p => -p[1]-0.25<=0.5+1e-6));
});
