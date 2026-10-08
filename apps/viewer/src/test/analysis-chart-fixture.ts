/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Native producers: pinned real-model clash run, IDS, BCF archive, IFC tasks and revision diff. */
import { readFile } from 'node:fs/promises';
import { IfcParser, extractScheduleOnDemand } from '@ifc-lite/parser';
import { createBCFProject, createBCFTopic, createViewpoint, addViewpointToTopic, readBCF, writeBCF } from '@ifc-lite/bcf';
import { diffModels } from '@ifc-lite/diff';
import { useViewerStore } from '@/store';
import { buildEntityFingerprints } from '@/lib/compare/buildFingerprints';
import type { AnalysisChartSource } from '@/lib/assistant/artifacts/analysis-chart';
import { seedScene } from './ai-eval-scenes';
import { seedArtifactModels, ARCH } from './artifact-models-fixture';
import { fixtureModel, fixtureModels } from './store-fixture';
import { CHART_TASK_IFC } from './chart-task-fixture';

export async function seedAnalysisChart(source: AnalysisChartSource): Promise<void> {
  if (source === 'clash' || source === 'ids') {
    const scene = await seedScene(source === 'clash' ? 'clash-rev-b' : 'validation-sample');
    if (scene.kind !== 'ready') throw new Error('Committed native chart scene must be available');
    useViewerStore.setState({ models: new Map([...useViewerStore.getState().models].map(([id, model]) => [id, { ...model, maxExpressId: Math.max(...(model.ifcDataStore?.entities.expressId ?? [])) }])) });
    return;
  }
  await seedArtifactModels();
  if (source === 'bcf') {
    const store = useViewerStore.getState().models.get(ARCH)?.ifcDataStore;
    if (!store) throw new Error('Committed sample is missing');
    const wall = store.entities.expressId.find(id => store.entities.getTypeName(id) === 'IfcWall');
    if (wall === undefined) throw new Error('Committed sample must have a wall');
    const project = createBCFProject({ name: 'Chart review #7106' });
    const open = createBCFTopic({ title: 'Source wall', author: 'r01', topicStatus: 'Open' });
    open.creationDate = '2026-09-01T10:00:00Z';
    addViewpointToTopic(open, createViewpoint({ camera: { position: { x: 0, y: 0, z: 10 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, fov: 1 }, selectedGuids: [store.entities.getGlobalId(wall)] }));
    const closed = createBCFTopic({ title: 'No loaded components', author: 'r01', topicStatus: 'Closed' });
    closed.creationDate = '2026-08-20T10:00:00Z';
    closed.modifiedDate = '2026-09-08T10:00:00Z';
    project.topics.set(open.guid, open); project.topics.set(closed.guid, closed);
    const archive = await writeBCF(project);
    useViewerStore.setState({ bcfProject: await readBCF(new Uint8Array(await archive.arrayBuffer())) });
    return;
  }
  if (source === 'schedule') {
    const bytes = new TextEncoder().encode(CHART_TASK_IFC);
    const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
    useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('tasks'), ifcDataStore: store, maxExpressId: 111 }), scheduleData: extractScheduleOnDemand(store),
      scheduleSourceModelId: 'tasks', animationEnabled: true, playbackTime: Date.UTC(2026, 8, 9, 12) });
    return;
  }
  const base = useViewerStore.getState().models.get(ARCH);
  if (!base?.ifcDataStore) throw new Error('Committed base revision is missing');
  const bytes = new Uint8Array(await readFile(new URL('../../public/samples/building-architecture-rev-b.ifc', import.meta.url)));
  const headStore = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const head = { ...fixtureModel('revision-b', { idOffset: 1_000_000 }), ifcDataStore: headStore, maxExpressId: Math.max(...headStore.entities.expressId) };
  useViewerStore.setState(fixtureModels(base, head));
  const basePrints = await buildEntityFingerprints({ modelId: ARCH, store: base.ifcDataStore, meshes: [], idOffset: 0 });
  const headPrints = await buildEntityFingerprints({ modelId: head.id, store: headStore, meshes: [], idOffset: head.idOffset });
  useViewerStore.setState({ compareRunSeq: 1, compareResult: { baseModelId: ARCH, headModelId: head.id, baseName: base.name, headName: 'Revision B',
    scope: 'data', geometryUnavailable: true, excludedHiddenIds: new Set(), mutationVersion: 0,
    diff: diffModels(basePrints, headPrints, { scope: 'data' }) } });
}
