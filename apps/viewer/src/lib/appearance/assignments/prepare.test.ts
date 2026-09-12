/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { appearanceAssets } from '../model-assets.js';
import { appearanceRevision, captureAppearanceSource } from '../command.js';
import { DEFAULT_APPEARANCE_SETTINGS } from '../settings.js';
import { applyAppearanceEntities } from '../apply-plan.js';
import type { AppearancePlanner } from '../planner-worker-client.js';
import type { CapturedAssignment } from './capture.js';
import { prepareAppearanceAssignments } from './prepare.js';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
const bytes = new TextEncoder().encode(`ISO-10303-21;
HEADER;FILE_DESCRIPTION(('Assignment sequencing'),'2;1');FILE_NAME('rows.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBUILDINGELEMENTPROXY('1ProxyImageTexture00000',$,'First',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.F.,((1,2,3)),$);#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#20=IFCBUILDINGELEMENTPROXY('2ProxyImageTexture00000',$,'Second',$,$,#11,#21,$,$);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));#22=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#23));
#23=IFCTRIANGULATEDFACESET(#15,$,.F.,((1,2,3)),$);
#30=IFCCOLOURRGB($,1.,1.,1.);#31=IFCSURFACESTYLESHADING(#30,0.);#32=IFCSURFACESTYLE($,.BOTH.,(#31));
#33=IFCSTYLEDITEM(#14,(#32),$);#34=IFCSTYLEDITEM(#23,(#32),$);
ENDSEC;END-ISO-10303-21;`);
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const unused = async (): Promise<never> => { throw new Error('Unused planner method'); };
async function fixture(assetId: string) {
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(store.properties, 'model');
  new StoreEditor(store, view);
  useViewerStore.setState({ models: new Map([['model', { ...fixtureModel('model'), ifcDataStore: store, schemaVersion: 'IFC4' }]]),
    mutationViews: new Map([['model', view]]), mutationVersion: 0, collabRoomId: null });
  const source = captureAppearanceSource(view), revision = appearanceRevision('model');
  const captured = [10, 20].map((productId, index): CapturedAssignment => ({
    assignment: { id: `row-${index}`, model: { modelId: 'model', slotId: 'slot', name: 'Model', sourceSha256: 'a'.repeat(64), revision },
      source: { id: assetId, name: 'Image', width: 1, height: 1 },
      settings: { ...DEFAULT_APPEARANCE_SETTINGS, plane: 'xy', tileWidth: index ? 4 : 2 }, query: { kind: 'selection', GlobalIds: [`guid-${productId}`] },
      members: [{ expressId: productId, GlobalId: `guid-${productId}` }], excludedGlobalIds: [] },
    snapshot: { modelId: 'model', revision, schema: 'IFC4', nextExpressId: view.peekNextExpressId(), bytes,
      catalog: { sourceRevision: revision, products: [], types: [], missingProductIds: [] }, productIds: [10, 20], source,
      validate: () => source.validate(useViewerStore.getState().mutationViews.get('model')) },
    validate: () => source.validate(useViewerStore.getState().mutationViews.get('model')),
  }));
  return { store, view, captured };
}

it('native sequential assignment plans preserve prior allocations and shared style users without publishing #4420', async t => {
  const wasm = new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  try { await access(wasm); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; t.skip('Build WASM with pnpm build:wasm'); return; }
  const { default: init } = await import('@ifc-lite/wasm'); await init({ module_or_path: await readFile(wasm) });
  const { runAppearancePlanning } = await import('../../../workers/appearance.worker.js');
  const planner: AppearancePlanner = { plan: runAppearancePlanning, pagePlan: unused, catalog: unused,
    pdfFidelity: unused, pdfFillPlan: unused, registerScan: unused, meshTransfer: unused, capturedMeshPlan: unused, annotationPlan: unused, cancel() {}, dispose() {} };
  const sourceOwner = { kind: 'source' as const, id: 'assignment-test' }, owner = { kind: 'draft' as const, id: 'assignment-test' };
  const asset = await appearanceAssets.add(png, { owner: sourceOwner });
  t.mock.method(appearanceAssets, 'decode', async () => ({ width: 1, height: 1, close() {} } as ImageBitmap));
  try {
    const { store, view, captured } = await fixture(asset.id), before = view.peekNextExpressId();
    const result = await prepareAppearanceAssignments({ captured, planner, owner, signal: new AbortController().signal });
    assert.equal(view.peekNextExpressId(), before); assert.equal(view.getMutations().length, 0);
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[1].plan.nextExpressId, result.steps[0].plan.nextAvailableExpressId);
    const editor = new StoreEditor(store, view);
    for (const step of result.steps) applyAppearanceEntities(editor, view, step.plan, captured[0].snapshot.revision);
    const exported = await new StepExporter(store, view).exportAsync({ schema: 'IFC4', applyMutations: true, includeGeometry: true, visibleOnly: false });
    const finalBytes = typeof exported.content === 'string' ? new TextEncoder().encode(exported.content) : exported.content;
    for (const [index, productId] of [10, 20].entries()) {
      const probe = await runAppearancePlanning(finalBytes, { schema: 'IFC4', sourceRevision: 'probe', nextExpressId: view.peekNextExpressId(), productIds: [productId],
        imageUri: 'probe.png', repeatS: true, repeatT: true, mapping: { kind: 'existingUv', scale: [1, 1], offset: [0, 0], rotationRadians: 0 } });
      assert.equal(probe.exclusions.length, 0);
      assert.equal(Math.max(...probe.items[0].texCoords.map(uv => uv[0])), index ? 0.25 : 0.5);
    }
    appearanceAssets.releaseOwner(owner);
    for (const failure of ['late worker failure', 'cancel', 'SDK edit', 'changed row'] as const) await t.test(failure, async () => {
      const state = await fixture(asset.id), controller = new AbortController();
      const watermark = state.view.peekNextExpressId(), history = useViewerStore.getState().undoStacks;
      let calls = 0;
      const failing: AppearancePlanner = { ...planner, async plan(input, request) {
        calls++;
        const result = await runAppearancePlanning(input, request);
        if (calls === 2) {
          if (failure === 'late worker failure') throw new Error('Injected late failure');
          if (failure === 'cancel') controller.abort();
          if (failure === 'SDK edit') new StoreEditor(state.store, state.view).setPositionalAttribute(10, 2, 'External edit');
          if (failure === 'changed row') state.captured[0].assignment.settings.tileWidth = 99;
        }
        return result;
      } };
      await assert.rejects(prepareAppearanceAssignments({ captured: state.captured, planner: failing, owner, signal: controller.signal }));
      assert.equal(calls, 2, 'one model row was fully prepared before the injected failure');
      assert.equal(state.view.peekNextExpressId(), watermark);
      assert.equal(state.view.getNewEntities().length, 0);
      assert.equal(state.view.getMutations().length, failure === 'SDK edit' ? 1 : 0);
      assert.equal(useViewerStore.getState().undoStacks, history);
      appearanceAssets.releaseOwner(sourceOwner);
      assert.equal(appearanceAssets.get(asset.id), undefined, 'failed draft released its only remaining image owner');
      await appearanceAssets.add(png, { owner: sourceOwner });
    });
  } finally { appearanceAssets.releaseOwner(owner); appearanceAssets.releaseOwner(sourceOwner); }
});
