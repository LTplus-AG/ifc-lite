/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { Camera, type Renderer, type RenderOptions } from '@ifc-lite/renderer';
import { placeholderSnapshotPng, writeBCF, type BCFProject } from '@ifc-lite/bcf';
import type { ValidationReport } from '@ifc-lite/ids';
import { useViewerStore } from '@/store';
import { fixtureDataStore, fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { expandToGeometryBearingIds } from '@/utils/aggregation';
import { registerViewportCapture } from '@/lib/viewport-capture';
import { setGlobalRendererRef } from '../useBCF';
import { runIdsBcfExport, type RunIdsBcfExportParams } from './idsBcfExport';

const guidA = '2O2Fr$t4X7Zf8NOew3FL01';
const guidB = '3P3Gs$u5Y8Ag9OPfx4GM02';
const childGuid = '0J4Hs$u5Y8Ag9OPfx4GM03';
const near = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 3, z: 1 } };
const far = { min: { x: 50, y: 10, z: -20 }, max: { x: 52, y: 13, z: -19 } };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

function report(): ValidationReport {
  return {
    source: { kind: 'rules', ruleSet: { name: 'Missing fire rating' } },
    timestamp: new Date('2026-10-21T00:00:00Z'), modelInfo: [],
    summary: { totalSpecifications: 1, passedSpecifications: 0, failedSpecifications: 1,
      totalEntitiesChecked: 2, totalEntitiesPassed: 0, totalEntitiesFailed: 2, overallPassRate: 0 },
    specificationResults: [{
      specification: { id: 'fire', name: 'Fire rating' }, status: 'fail',
      applicableCount: 2, passedCount: 0, failedCount: 2, passRate: 0,
      entityResults: [10, 20].map((expressId, i) => ({
        modelId: i === 0 ? 'A' : 'B', expressId, globalId: i === 0 ? guidA : guidB,
        entityType: i === 0 ? 'IfcWall' : 'IfcElementAssembly', passed: false,
        requirementResults: [{ requirement: { id: 'rating', label: 'FireRating', optionality: 'required' },
          status: 'fail', facetType: 'property', checkedDescription: 'FireRating must exist' }],
      })),
    }],
  };
}

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.(); dispose = undefined;
  setGlobalRendererRef({ current: null });
  useViewerStore.setState({ cameraCallbacks: {} });
  mock.restoreAll();
});

function setup(expand: boolean, snapshots = false, cameraEnabled = true) {
  const camera = new Camera();
  camera.setPosition(30, 20, 25); camera.setTarget(1, 2, 3); camera.setAspect(4 / 3);
  const renders: RenderOptions[] = [];
  const renderer = {
    getCamera: () => camera,
    getScene: () => ({ getEntityBoundingBox: (id: number) => id === 10 ? near : id === 1_000_021 ? far : null,
      getInstancedEntityBounds: () => null }),
    renderWithResult: (options: RenderOptions) => { renders.push(options); return true; },
    getGPUDevice: () => null, requestRender: () => {},
  } as unknown as Renderer;
  setGlobalRendererRef({ current: renderer });
  useViewerStore.setState({ cameraCallbacks: { resolveHighlightIds: ids =>
    ids.flatMap(id => expand && id === 1_000_020 ? [1_000_021] : [id]) } });
  const canvas = document.createElement('canvas');
  // The GPU boundary is replaced, while production camera/capture/export/ZIP code runs.
  canvas.toDataURL = () => png;
  dispose = registerViewportCapture(renderer, canvas, () => ({
    sectionPlane: { axis: 'side', position: 0, enabled: true },
    extraSectionPlanes: [{ axis: 'front', position: 100, enabled: true }],
    clipBox: { min: [900, 900, 900], max: [901, 901, 901], enabled: true },
    terrainClipY: -999,
  }));
  mock.method(URL, 'createObjectURL', () => 'blob:ids-bcf-test');
  mock.method(URL, 'revokeObjectURL', () => {});
  let project: BCFProject | undefined;
  const model = fixtureModel('A', { entities: [{ expressId: 10, type: 'IfcWall', globalId: guidA }] });
  model.loadedAt = 1;
  model.maxExpressId = 10;
  model.geometryResult = { meshes: [], totalVertices: 0, totalTriangles: 0,
    coordinateInfo: { originShift: { x: 100, y: 30, z: -200 }, hasLargeCoordinates: true,
      originalBounds: near, shiftedBounds: near } };
  const second = fixtureModel('B', { idOffset: 1_000_000, entities: [
    { expressId: 20, type: 'IfcElementAssembly', globalId: guidB },
    { expressId: 21, type: 'IfcWall', globalId: childGuid },
  ] });
  second.maxExpressId = 21;
  useViewerStore.setState(fixtureModels(model, second));
  const params: RunIdsBcfExportParams = {
    report: report(), models: new Map([['A', model], ['B', second]]), legacyGeometryResult: null,
    toViewerGlobalId: (modelId, id) => modelId === 'B' ? 1_000_000 + id : id,
    settings: { topicGrouping: 'per-specification', includePassingEntities: false,
      includeCamera: cameraEnabled, includeSnapshots: snapshots, loadIntoBcfPanel: true },
    bcfAuthor: 'reviewer@example.com', setBcfExportProgress: () => {},
    setBcfPanelVisible: () => {}, setBcfProject: value => { project = value; },
  };
  return { camera, renders, params, exported: () => { assert.ok(project); return project; } };
}

async function archive(project: BCFProject) {
  const zip = await JSZip.loadAsync(await (await writeBCF(project)).arrayBuffer());
  const topic = [...project.topics.values()][0];
  const markup = await zip.file(`${topic.guid}/markup.bcf`)!.async('string');
  const name = markup.match(/<Viewpoint>([^<]+)<\/Viewpoint>/)?.[1];
  assert.ok(name, 'markup must link an actual viewpoint');
  const viewpoint = await zip.file(`${topic.guid}/${name}`)!.async('string');
  return { zip, topic, markup, viewpoint };
}

describe('#7974 actual viewer IDS BCF export', () => {
  it('frames a federated assembly through its descendants and writes one grouped snapshot', async () => {
    const run = setup(true, true);
    const before = { ...run.camera.getPosition() };
    await runIdsBcfExport(run.params);
    const result = await archive(run.exported());
    assert.equal(run.exported().topics.size, 1);
    assert.equal(run.renders.length, 1, 'one capture per topic, not per entity');
    assert.equal(run.renders[0].sectionPlane, undefined, 'snapshot must match the unclipped BCF viewpoint');
    assert.equal(run.renders[0].extraSectionPlanes, undefined);
    assert.equal(run.renders[0].clipBox, undefined);
    assert.equal(run.renders[0].terrainClipY, undefined);
    assert.deepEqual([...run.renders[0].isolatedIds!].sort(), [10, 1_000_020, 1_000_021]);
    assert.deepEqual(run.camera.getPosition(), before, 'capture restores the user camera');
    assert.match(result.viewpoint, /<PerspectiveCamera>/);
    assert.match(result.viewpoint, new RegExp(guidA.replace(/\$/g, '\\$')));
    assert.match(result.viewpoint, new RegExp(guidB.replace(/\$/g, '\\$')));
    const snapshot = result.markup.match(/<Snapshot>([^<]+)<\/Snapshot>/)?.[1];
    assert.ok(snapshot);
    assert.ok((await result.zip.file(`${result.topic.guid}/${snapshot}`)!.async('uint8array')).length > 0);
    assert.ok(result.topic.comments.every(comment => comment.viewpointGuid === result.topic.viewpoints[0].guid));
    const components = result.topic.viewpoints[0].components;
    assert.ok(components?.visibility?.exceptions?.some(component => component.ifcGuid === childGuid));
    assert.ok(components?.coloring?.[0].components.some(component => component.ifcGuid === childGuid));
    assert.doesNotMatch(result.topic.description ?? '', /current viewer camera/);
  });

  it('keeps model context for a geometry-less spatial container with meshed spatial aggregates (#7974)', async () => {
    const run = setup(true, true);
    const spec = run.params.report.specificationResults[0];
    spec.entityResults = [spec.entityResults[1]];
    spec.entityResults[0].entityType = 'IfcBuilding';
    spec.applicableCount = 1; spec.failedCount = 1;
    const store = fixtureDataStore([
      { expressId: 20, type: 'IfcBuilding', globalId: guidB },
      { expressId: 21, type: 'IfcSpace', globalId: childGuid },
      { expressId: 22, type: 'IfcWall', globalId: guidA },
    ], { aggregates: { 20: [21] } });
    const model = run.params.models.get('B')!;
    model.ifcDataStore = store;
    useViewerStore.setState({ cameraCallbacks: { resolveHighlightIds: ids =>
      expandToGeometryBearingIds(ids, id => id === 1_000_021, {
        resolve: id => ({ modelId: 'B', expressId: id - 1_000_000 }),
        relationshipsFor: () => store.relationships,
        toGlobalId: (_modelId, id) => 1_000_000 + id,
      }) } });
    await runIdsBcfExport(run.params);
    const result = await archive(run.exported());
    const vp = result.topic.viewpoints[0];
    assert.deepEqual(vp.components?.selection, [{ ifcGuid: guidB }]);
    assert.equal(vp.components?.visibility?.defaultVisibility, true,
      'aggregate-only spatial geometry must not hide the physically contained building elements');
    assert.equal(run.renders[0].isolatedIds, null, 'snapshot must show the physical model context');
    assert.deepEqual(vp.perspectiveCamera?.cameraViewPoint, { x: 130, y: 175, z: 50 },
      'spatial descendant bounds must not replace the current useful house view');
    assert.match(result.topic.description ?? '', /spatial container has no direct geometry/);
    assert.match(result.topic.description ?? '', /current viewer camera/);
    assert.match(result.markup, /<Snapshot>/);
    assert.doesNotMatch(result.viewpoint, new RegExp(childGuid.replace(/\$/g, '\\$')),
      'spatial decomposition alone is not the building visibility or colour group');
  });

  for (const mode of ['perspective', 'orthographic'] as const) {
    it(`keeps a usable ${mode} camera when one failure has no geometry`, async () => {
      const run = setup(false);
      run.camera.setProjectionMode(mode); run.camera.setOrthoSize(12);
      await runIdsBcfExport(run.params);
      const { topic, viewpoint } = await archive(run.exported());
      const vp = topic.viewpoints[0];
      const exportedCamera = vp.perspectiveCamera ?? vp.orthogonalCamera;
      assert.ok(exportedCamera);
      // Y-up (30,20,25) plus render-frame offset (100,30,-200) -> IFC Z-up.
      assert.deepEqual(exportedCamera.cameraViewPoint, { x: 130, y: 175, z: 50 });
      assert.match(viewpoint, mode === 'perspective' ? /<PerspectiveCamera>/ : /<OrthogonalCamera>/);
      if (mode === 'orthographic') assert.equal(vp.orthogonalCamera?.viewToWorldScale, 24);
      assert.match(topic.description ?? '', /current viewer camera/);
      assert.equal(vp.components?.selection?.length, 2, 'unframeable failures remain reviewable');
    });
  }

  it('honors camera-off while retaining the requested grouped snapshot', async () => {
    const run = setup(true, true, false);
    await runIdsBcfExport(run.params);
    const { viewpoint, markup } = await archive(run.exported());
    assert.doesNotMatch(viewpoint, /<(Perspective|Orthogonal)Camera>/);
    assert.match(markup, /<Snapshot>/);
    assert.equal(run.renders.length, 1);
  });

  // BIMcollab Zoom reports "no viewpoint to zoom to" for any viewpoint whose
  // markup has no <Snapshot>, even with a valid camera (#7974).
  it('captures a real grouped snapshot even when snapshots were not requested', async () => {
    const run = setup(true);
    await runIdsBcfExport(run.params);
    const { zip, topic, markup } = await archive(run.exported());
    assert.equal(run.renders.length, 1);
    const snapshot = markup.match(/<Snapshot>([^<]+)<\/Snapshot>/)?.[1];
    assert.ok(snapshot, 'grouped viewpoint must reference a snapshot');
    const bytes = await zip.file(`${topic.guid}/${snapshot}`)!.async('uint8array');
    assert.notDeepEqual(bytes, placeholderSnapshotPng(), 'a renderer was available, so the image must be real');
  });

  it('falls back to the placeholder when a grouped capture fails, whatever the hidden switch says', async () => {
    // The switch is shown locked on for grouped exports, so a value left over
    // from per-entity must not turn a capture miss into an export error.
    const run = setup(true, true);
    dispose?.(); dispose = undefined;
    await runIdsBcfExport(run.params);
    const { zip, topic, markup } = await archive(run.exported());
    const snapshot = markup.match(/<Snapshot>([^<]+)<\/Snapshot>/)?.[1];
    assert.ok(snapshot);
    assert.deepEqual(await zip.file(`${topic.guid}/${snapshot}`)!.async('uint8array'), placeholderSnapshotPng());
  });

  it('gives per-entity viewpoints a placeholder snapshot without rendering one', async () => {
    const run = setup(true);
    run.params.settings.topicGrouping = 'per-entity';
    await runIdsBcfExport(run.params);
    const project = run.exported();
    assert.equal(project.topics.size, 2);
    assert.equal(run.renders.length, 0, 'per-entity snapshots stay opt-in');
    const zip = await JSZip.loadAsync(await (await writeBCF(project)).arrayBuffer());
    for (const topic of project.topics.values()) {
      const markup = await zip.file(`${topic.guid}/markup.bcf`)!.async('string');
      const snapshot = markup.match(/<Snapshot>([^<]+)<\/Snapshot>/)?.[1];
      assert.ok(snapshot, `${topic.title} must reference a snapshot`);
      assert.deepEqual(await zip.file(`${topic.guid}/${snapshot}`)!.async('uint8array'), placeholderSnapshotPng());
    }
  });

  it('refuses a requested camera when neither complete bounds nor a renderer exist', async () => {
    const run = setup(false);
    setGlobalRendererRef({ current: null });
    await assert.rejects(runIdsBcfExport(run.params), /camera|renderer/i);
  });

  it('reports a failed requested snapshot instead of silently downloading an incomplete archive', async () => {
    const run = setup(true, true);
    run.params.settings.topicGrouping = 'per-entity';
    dispose?.(); dispose = undefined;
    await assert.rejects(runIdsBcfExport(run.params), /snapshot/i);
  });
});
