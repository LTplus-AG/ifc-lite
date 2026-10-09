/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { afterEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { ARCH, seedArtifactModels } from '@/test/artifact-models-fixture';
import { cameraStub } from '@/test/scene-actions-fixture';
import { parseSceneActions } from './scene-actions';
import { applySceneActions } from './scene-apply';
import { restoreSceneApplication } from './scene-restore';
import { setActiveApplication, useSceneSession } from './scene-session';

const initial = useViewerStore.getState();
afterEach(() => { setActiveApplication(null); useViewerStore.setState(initial, true); });
async function apply(federated: boolean) {
  await seedArtifactModels({ federated });
  const state = useViewerStore.getState();
  const source = state.models.get(ARCH)!;
  const ids = source.ifcDataStore!.entityIndex.byType.get('IFCWALL')!;
  assert.ok(ids.length >= 2, 'independent SketchUp sample supplies two actual walls');
  const first = source.ifcDataStore!.entities.getGlobalId(ids[0]);
  const second = source.ifcDataStore!.entities.getGlobalId(ids[1]);
  const camera = cameraStub();
  useViewerStore.setState({ cameraCallbacks: camera.callbacks });
  const result = applySceneActions(parseSceneActions(JSON.stringify({ version: 1, kind: 'scene.actions', title: 'Native source ownership', actions: [
    { type: 'select', targets: [{ globalId: first, modelId: ARCH }] },
    { type: 'isolate', targets: [{ globalId: first, modelId: ARCH }] },
    { type: 'hide', targets: [{ globalId: second, modelId: ARCH }] },
    { type: 'colour', groups: [{ label: 'Wall', colour: 'red', targets: [{ globalId: first, modelId: ARCH }] }] },
    { type: 'section', units: 'm', plane: { origin: [0.5, 0.5, 0.5], normal: [0, 0, 1] } },
    { type: 'camera', units: 'm', eye: [0.5, 0.5, 5], target: [0.5, 0.5, 0.5] },
  ] })), null);
  assert.deepEqual(result?.applied.map(row => row.type), ['hide', 'isolate', 'colour', 'select', 'section', 'camera']);
  const active = useSceneSession.getState().active; assert.ok(active);
  return { source, camera, active };
}
for (const federated of [false, true]) test(`#7257 same-ID parsed source replacement refuses every scene restore channel, N=${federated ? 2 : 1}`, async () => {
  const { camera, active, source } = await apply(federated);
  // Parse the independent committed hello-wall IFC, retaining the loaded model ID.
  const bytes = readFileSync(new URL('../../../public/samples/hello-wall.ifc', import.meta.url));
  const replacement = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  assert.notEqual(replacement, source.ifcDataStore);
  assert.notEqual(replacement.entities.count, source.ifcDataStore!.entities.count, 'independent authoring samples have distinct native populations');
  useViewerStore.getState().updateModel(ARCH, { ifcDataStore: replacement });
  const before = useViewerStore.getState(); const cameraWrites = camera.applied.length;
  const report = restoreSceneApplication(active);
  assert.deepEqual(report.channels.map(row => row.outcome), Array(6).fill('models-changed'));
  const after = useViewerStore.getState();
  assert.equal(after.hiddenEntities, before.hiddenEntities, 'replacement visibility is not revealed');
  assert.equal(after.selectedEntitiesSet, before.selectedEntitiesSet, 'replacement selection is not overwritten');
  assert.equal(after.pendingColorUpdates, before.pendingColorUpdates);
  assert.equal(after.sectionPlane, before.sectionPlane);
  assert.equal(camera.applied.length, cameraWrites, 'no stale viewpoint dispatch');
});

test('#7257 native model rename and collapse preserve all six restore channels', async () => {
  const { active } = await apply(true);
  useViewerStore.getState().updateModel(ARCH, { name: 'Reviewed architectural source', collapsed: true });
  assert.deepEqual(restoreSceneApplication(active).channels.map(row => row.outcome), Array(6).fill('restored'));
});
test('#7257 temporary native unload cannot revive ownership when the original model returns', async () => {
  const { source, active } = await apply(true);
  useViewerStore.getState().removeModel(ARCH);
  useViewerStore.getState().addModel(source);
  assert.equal(useViewerStore.getState().models.get(ARCH)?.ifcDataStore, source.ifcDataStore);
  assert.deepEqual(restoreSceneApplication(active).channels.map(row => row.outcome), Array(6).fill('models-changed'));
});
test('#7257 primary-slot source replacement refuses scene restore with no federation registry', async () => {
  await seedArtifactModels();
  const state = useViewerStore.getState(); const camera = cameraStub();
  useViewerStore.setState({ models: new Map(), activeModelId: null, cameraCallbacks: camera.callbacks });
  const result = applySceneActions(parseSceneActions(JSON.stringify({ version: 1, kind: 'scene.actions', title: 'Primary source', actions: [
    { type: 'section', units: 'm', plane: { origin: [0.5, 0.5, 0.5], normal: [0, 0, 1] } },
    { type: 'camera', units: 'm', eye: [0.5, 0.5, 5], target: [0.5, 0.5, 0.5] },
  ] })), null);
  assert.deepEqual(result?.applied.map(row => row.type), ['section', 'camera']);
  const active = useSceneSession.getState().active; assert.ok(active);
  const bytes = readFileSync(new URL('../../../public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  assert.notEqual(store, state.ifcDataStore);
  useViewerStore.setState({ ifcDataStore: store });
  assert.deepEqual(restoreSceneApplication(active).channels.map(row => row.outcome), ['models-changed', 'models-changed']);
});
