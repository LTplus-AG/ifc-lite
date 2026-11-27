/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #10791: an operation must not act, or capture stale state, after it is cancelled or its scene changed. */
import '@/test/setup-dom.js';
import '@/test/content-fixture';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Renderer } from '@ifc-lite/renderer';
import { createBimContext } from '@ifc-lite/sdk';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { clearGlobalRefs, setGlobalCanvasRef, setGlobalRendererRef } from '@/hooks/useBCF';
import { captureNativeBcfViewpoint } from '@/hooks/bcf/capture-viewpoint';
import { captureViewportFrame, registerViewportCapture } from '@/lib/viewport-capture';
import { exportPreparedChartReport } from '@/lib/export/report/export-prepared-chart-report';
import { exportPreparedDocument } from '@/lib/document/export-prepared-document';
import { DOCUMENT_VERSION } from '@/lib/document/types';
import * as jspdf from 'jspdf';
import { installSvgCdataEnvironmentConversion } from '@/test/svg-cdata';
import { aggregate } from '@ifc-lite/charts';
import { cityJsonEngine } from '@/lib/export/native-cityjson';
import { runIdsBcfExport } from '@/hooks/ids/idsBcfExport';
import { wallFixture } from '@/test/ids-studio-fixture';
import { seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { loadIdsStudioRuntime } from '@/lib/ids-studio/runtime-loader';
import { createMainViewerToolHost } from '../main-viewer-host';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';
import type { ToolHost } from '../types';
import { clashSettings } from './clash-native';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
let host: ToolHost;
let viewport: ReturnType<typeof installViewport>;

/** A GPU-free canonical viewport: counts the frames it renders and runs `onRender` inside each. */
function installViewport() {
  const state = { renders: 0, submit: true, onRender: () => {}, onOptions: () => {}, gpu: null as null | (() => Promise<void>) };
  const camera = {
    getPosition: () => ({ x: 10, y: 5, z: 20 }), getTarget: () => ({ x: 1, y: 2, z: 3 }), getUp: () => ({ x: 0, y: 1, z: 0 }),
    getFOV: () => Math.PI / 4, getProjectionMode: () => 'perspective', getOrthoSize: () => 10, getAspect: () => 16 / 9, getDistance: () => 10,
    frameBounds: async () => {}, animateToWithUp: async () => {}, setOrthoSize: () => {}, setProjectionMode: () => {}, setFOV: () => {},
  };
  const renderer = {
    renderWithResult: () => { state.renders++; state.onRender(); return state.submit; },
    requestRender: () => {},
    getGPUDevice: () => state.gpu ? { queue: { onSubmittedWorkDone: state.gpu } } : null,
    getCamera: () => camera,
    getScene: () => ({ getInstancedEntityBounds: () => null, getEntityBoundingBox: () => null, getAllInstancedMeshData: () => [] }),
  } as unknown as Renderer;
  const canvas = document.createElement('canvas');
  canvas.toDataURL = () => PNG;
  setGlobalRendererRef({ current: renderer });
  setGlobalCanvasRef({ current: canvas });
  const unregister = registerViewportCapture(renderer, canvas, () => { state.onOptions(); return {}; });
  return { state, renderer, canvas, dispose: () => { unregister(); clearGlobalRefs(); } };
}

const execute = (id: string, input: unknown, signal?: AbortSignal) =>
  dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id: id, input }, { canEdit: () => true, signal });
async function clashRun(): Promise<{ run_seq: number; ids: string[] }> {
  const input = { kind: 'all', preset_id: '', expected_model_ids: [...useViewerStore.getState().models.keys()], expected_settings: JSON.stringify(clashSettings()) };
  const result = await execute('clash.run', input);
  assert.equal(result.isError, false, result.text);
  const s = useViewerStore.getState();
  return { run_seq: s.clashRunSeq, ids: s.clashResult!.clashes.map(clash => clash.id) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
const unloadModelB = () => {
  const models = new Map(useViewerStore.getState().models);
  models.delete('B');
  useViewerStore.setState({ models });
};

describe('viewer operations: no effects after cancel and no stale captures (#10791)', () => {
  beforeEach(async () => {
    await seedCoincidentWalls(2);
    const s = useViewerStore.getState();
    s.clearClashExclusions(); s.setClashMode('hard'); s.setClashTolerance(0.002); s.setClashReportTouch(false);
    useViewerStore.setState({ bcfProject: null, hiddenEntities: new Set(), isolatedEntities: null });
    host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
    viewport = installViewport();
  });
  afterEach(() => viewport.dispose());

  it('#77: a capture still queued when its caller cancels never takes the viewport', async () => {
    let finishFirst = () => {};
    const held = new Promise<void>(resolve => { finishFirst = resolve; });
    viewport.state.gpu = () => held;
    const first = captureViewportFrame(viewport.renderer, { read: () => 'first' });
    const controller = new AbortController();
    const second = captureViewportFrame(viewport.renderer, { read: () => 'second', signal: controller.signal });
    await settle();
    controller.abort();
    finishFirst();
    assert.equal(await first, 'first');
    assert.equal(await second, null);
    assert.equal(viewport.state.renders, 1, 'the cancelled capture rendered no frame');
  });

  it('#10791: cancelling an agent screenshot while queued renders no frame', async () => {
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let markFirstStarted = () => {};
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    viewport.state.gpu = () => { markFirstStarted(); return held; };
    const first = captureViewportFrame(viewport.renderer, { read: () => 'first' });
    await firstStarted; // The first request already read its options and owns the viewport.
    const controller = new AbortController();
    const queued = new Promise<void>(resolve => { viewport.state.onOptions = resolve; });
    const screenshot = execute('exports.screenshot', { scope: 'current-view' }, controller.signal);
    try {
      await Promise.race([queued, screenshot.then(result => assert.fail(result.text))]);
      controller.abort();
    } finally {
      release();
      await first;
    }
    const result = await screenshot;
    assert.equal(result.errorCode, 'CANCELLED', result.text);
    assert.equal(viewport.state.renders, 1, 'only the first capture rendered');
  });

  for (const kind of ['chart report', 'document'] as const)
    it(`#71: a cancelled ${kind} export takes no further snapshot frames`, async () => {
      const dataset = { source: 'elements' as const, columns: [{ id: 'T', label: 'Type', kind: 'category' as const }],
        rows: [{ ids: [1], values: ['Wall'] }], fingerprint: 't' };
      const specs = ['a', 'b', 'c'].map(id => ({ id, title: `Chart ${id}`, source: 'elements' as const, type: 'bar' as const, dimension: 'T', measure: { agg: 'count' as const } }));
      const aggregations = new Map(specs.map(spec => [spec.id, aggregate(spec, dataset)]));
      const controller = new AbortController();
      viewport.state.submit = false; // a frame without pixels: the export draws its placeholder
      viewport.state.onRender = () => controller.abort();
      const previous = Reflect.get(window, 'jspdf');
      Reflect.set(window, 'jspdf', jspdf);
      const restoreSvg = installSvgCdataEnvironmentConversion();
      try {
        const page = { size: 'A4' as const, orientation: 'portrait' as const };
        const exported = kind === 'chart report'
          ? exportPreparedChartReport({ name: 'Report', page, titleBlock: {}, snapshots: true,
            charts: specs.map(spec => ({ id: spec.id, title: spec.title, snapshot: true, aggregation: aggregations.get(spec.id)! })), snapshotIds: () => [1] }, { signal: controller.signal })
          : exportPreparedDocument({ document: { version: DOCUMENT_VERSION, id: 'd', name: 'Document', page,
            blocks: specs.map(spec => ({ kind: 'chart' as const, id: spec.id, chart: spec, snapshot: true })) },
          bindings: { models: [], activeModelId: null, today: new Date(0) }, aggregations, chartMessages: new Map(), topics: new Map(), tables: new Map(), snapshotIds: () => [1] },
          { signal: controller.signal });
        await assert.rejects(exported, { name: 'AbortError' });
      } finally { restoreSvg(); Reflect.set(window, 'jspdf', previous); }
      assert.equal(viewport.state.renders, 1, 'charts after the cancel took no frame');
    });

  it('#6: a cancelled group topic never frames the camera when its animation frame resumes', async () => {
    await seedCoincidentWalls(1);
    const { run_seq, ids } = await clashRun();
    let framed = 0;
    useViewerStore.setState(s => ({ cameraCallbacks: { ...s.cameraCallbacks, frameSelection: () => { framed++; return true; } } }));
    const controller = new AbortController();
    // The group focus paints its colours synchronously after scheduling the frame: cancel right there.
    const stop = useViewerStore.subscribe((s, prev) => {
      if (s.clashHighlightColors && s.clashHighlightColors !== prev.clashHighlightColors) controller.abort();
    });
    try {
      const result = await execute('clash.topic.create', { kind: 'group', clash_ids: ids, run_seq, group_name: 'Group', mode: 'highlight' }, controller.signal);
      assert.equal(result.isError, true, result.text);
    } finally { stop(); }
    await settle();
    assert.equal(controller.signal.aborted, true, 'cancelled after the focus scheduled its frame');
    assert.equal(framed, 0, 'no camera move after cancellation');
    assert.equal(useViewerStore.getState().bcfProject, null);
  });

  it('reports superseded clash topic capture as stale (#10871)', async () => {
    const { run_seq } = await clashRun();
    viewport.state.onRender = () => useViewerStore.setState({ clashRunSeq: run_seq + 1 });
    const result = await execute('clash.topic.create', { kind: 'report', clash_ids: [], run_seq, group_name: '', mode: 'highlight' });
    assert.ok(viewport.state.renders > 0, 'the result changed during capture');
    assert.equal(result.errorCode, 'STATE_CHANGED', result.text);
    assert.equal(useViewerStore.getState().bcfProject, null);
  });

  it('#6: clash.focus keeps framing the group after its call has returned', async () => {
    await seedCoincidentWalls(1, 3);
    const { run_seq, ids } = await clashRun();
    assert.ok(ids.length > 1, 'a group focus');
    let framed = 0;
    useViewerStore.setState(s => ({ cameraCallbacks: { ...s.cameraCallbacks, frameSelection: () => { framed++; return true; } } }));
    const controller = new AbortController();
    const result = await execute('clash.focus', { clash_ids: ids, run_seq, mode: 'highlight', element: 'pair' }, controller.signal);
    assert.equal(result.isError, false, result.text);
    controller.abort(); // the call is over: its signal no longer owns the dispatched framing
    await settle();
    assert.equal(framed, 1);
  });

  it('#10: clash.topic.create refuses when its snapshot frame fails instead of publishing a camera-only topic', async () => {
    await seedCoincidentWalls(1);
    const { run_seq, ids } = await clashRun();
    viewport.state.submit = false;
    const result = await execute('clash.topic.create', { kind: 'pair', clash_ids: [ids[0]], run_seq, group_name: '', mode: 'highlight' });
    assert.equal(result.isError, true, result.text);
    assert.equal(viewport.state.renders > 0, true, 'the capture was attempted');
    assert.equal(useViewerStore.getState().bcfProject?.topics.size ?? 0, 0);
    viewport.state.submit = true;
    const control = await execute('clash.topic.create', { kind: 'pair', clash_ids: [ids[0]], run_seq, group_name: '', mode: 'highlight' });
    assert.equal(control.isError, false, control.text);
    assert.equal(useViewerStore.getState().bcfProject?.topics.size, 1);
  });

  it('#77: a cancelled pair topic queued behind another capture takes no frame', async () => {
    await seedCoincidentWalls(1);
    const { run_seq, ids } = await clashRun();
    let finishFirst = () => {};
    const held = new Promise<void>(resolve => { finishFirst = resolve; });
    viewport.state.gpu = () => held;
    const first = captureViewportFrame(viewport.renderer, { read: () => 'first' });
    const controller = new AbortController();
    const topic = execute('clash.topic.create', { kind: 'pair', clash_ids: [ids[0]], run_seq, group_name: '', mode: 'highlight' }, controller.signal);
    // The topic frames its pair (two animation frames), then queues its capture behind the held one.
    const queued = await Promise.race([topic.then(() => false), new Promise<boolean>(resolve => setTimeout(() => resolve(true), 500))]);
    assert.equal(queued, true, 'the topic is waiting on the viewport');
    controller.abort();
    finishFirst();
    await first;
    assert.equal((await topic).isError, true);
    assert.equal(viewport.state.renders, 1, 'the cancelled topic rendered no frame');
    assert.equal(useViewerStore.getState().bcfProject, null);
  });

  it('#7: clash.exportBcf refuses snapshots once a model unloads mid-export', async () => {
    const { run_seq } = await clashRun();
    viewport.state.onRender = unloadModelB;
    const result = await execute('clash.exportBcf', { run_seq, groupBy: 'element', severities: ['critical', 'major', 'minor', 'info'], includeSnapshots: true, maxTopics: 10, clash_ids: [] });
    assert.equal(result.isError, true, result.text);
    assert.match(result.text, /unloaded during the clash BCF export/);
    assert.equal(viewport.state.renders, 1);
    await seedCoincidentWalls(2);
    viewport.state.onRender = () => {};
    const control = await clashRun();
    const exported = await execute('clash.exportBcf', { run_seq: control.run_seq, groupBy: 'element', severities: ['critical', 'major', 'minor', 'info'], includeSnapshots: true, maxTopics: 10, clash_ids: [] });
    assert.equal(exported.isError, false, exported.text);
  });

  it('#9: visibility GUIDs are bound before the GPU wait, not resolved against the models after it', async () => {
    const guid = useViewerStore.getState().models.get('B')!.ifcDataStore!.entities.getGlobalId(1);
    assert.ok(guid);
    useViewerStore.setState({ hiddenEntities: new Set([101]) });
    viewport.state.onRender = unloadModelB;
    const viewpoint = await captureNativeBcfViewpoint(viewport.renderer, viewport.canvas, { includeSnapshot: true, includeSelection: false, includeHidden: true });
    assert.ok(viewpoint);
    assert.deepEqual(viewpoint.components?.visibility?.exceptions?.map(component => component.ifcGuid), [guid]);
  });

  it('#70/#81: exports.cityjson stops between its awaits when the model changes', async (t) => {
    const models = new Map(useViewerStore.getState().models);
    // An empty parsed source makes the producer read the file, an await the test can interleave with.
    const store = models.get('A')!.ifcDataStore!;
    const file = new File(['ISO-10303-21;'], 'a.ifc');
    models.set('A', { ...models.get('A')!, ifcDataStore: { ...store, source: { byteLength: 0 } } as never, sourceFile: file });
    useViewerStore.setState({ models, georefMutations: new Map() });
    const bump = () => useViewerStore.setState(s => ({ mutationVersion: s.mutationVersion + 1 }));
    const edit = { duringLoad: false, duringSource: false };
    let reads = 0, writes = 0;
    t.mock.method(file, 'arrayBuffer', async () => { reads++; if (edit.duringSource) bump(); return new TextEncoder().encode('ISO-10303-21;').buffer; });
    const engine = { exportCityJson: async () => { writes++; return { text: '{}', warnings: [] }; }, cityJsonRefusalReason: () => null };
    t.mock.method(cityJsonEngine, 'load', async () => { if (edit.duringLoad) bump(); return engine; });
    const exportA = () => execute('exports.cityjson', { target_model_id: 'A', sequence: false });
    // #81: edited while the writer loads; the source is never resolved.
    edit.duringLoad = true;
    const afterLoad = await exportA();
    assert.equal(afterLoad.isError, true, afterLoad.text);
    assert.match(afterLoad.text, /changed during export/);
    assert.equal(reads, 0, 'no source read after the load-time edit');
    // #70: edited while its STEP source resolves; the writer never runs.
    edit.duringLoad = false; edit.duringSource = true;
    const afterSource = await exportA();
    assert.equal(afterSource.isError, true, afterSource.text);
    assert.match(afterSource.text, /changed during export/);
    assert.equal(writes, 0, 'the writer never ran on a changed model');
    edit.duringSource = false;
    const control = await exportA();
    assert.equal(control.isError, false, control.text);
    assert.equal(writes, 1);
  });
});

describe('IDS BCF topic captures stop at cancellation (#10791 #66)', () => {
  beforeEach(async () => {
    await seedAuthoringSample();
    const fixture = await wallFixture();
    await loadIdsStudioRuntime();
    useViewerStore.setState({ idsStudioState: fixture.state, idsStudioContexts: fixture.contexts, idsStudioRevision: 0, idsStudioRejection: null });
    host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
    viewport = installViewport();
  });
  afterEach(() => viewport.dispose());

  it('topics after a cancel take no viewport frames', async () => {
    const value = async <T>(id: string, input: unknown, write = false): Promise<T> => {
      const result = await dispatchMainViewerTool(host, write ? 'viewer_operation_execute' : 'viewer_operation_inspect', { operation_id: id, input }, { canEdit: () => true });
      assert.equal(result.isError, false, result.text);
      return JSON.parse((result.structured as { result: { native_json: string } }).result.native_json) as T;
    };
    const { content } = await value<{ content: string }>('ids.document.xml', {});
    const { run_id } = await value<{ run_id: string }>('validation.ids.run', { xml: content, scope: 'whole', entity_ids: [] });
    await value('validation.publish', { run_id }, true);
    const state = useViewerStore.getState();
    const params = { report: state.idsValidationReport!, models: state.models, legacyGeometryResult: null, toViewerGlobalId: () => undefined, bcfAuthor: undefined,
      settings: { topicGrouping: 'per-entity' as const, includePassingEntities: false, includeCamera: false, includeSnapshots: true, loadIntoBcfPanel: false },
      setBcfProject: () => {}, setBcfPanelVisible: () => {}, emit: () => {} };
    await runIdsBcfExport({ ...params, setBcfExportProgress: () => {} });
    const topics = viewport.state.renders;
    assert.ok(topics > 0, 'the uncancelled export captures one frame per topic');
    viewport.state.renders = 0;
    const controller = new AbortController();
    await assert.rejects(runIdsBcfExport({ ...params, signal: controller.signal,
      setBcfExportProgress: progress => { if (progress?.phase === 'snapshots') controller.abort(); } }), { name: 'AbortError' });
    assert.equal(viewport.state.renders, 0, 'no topic took the viewport after the cancel');
  });
});
