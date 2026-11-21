/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import type { Renderer } from '@ifc-lite/renderer';
import { clearGlobalRefs, setGlobalRendererRef } from '@/hooks/useBCF';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { resetFeaturesForTest } from '@/lib/features';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';
import { createMainViewerToolHost } from '../main-viewer-host';
import { operationArtifacts, readArtifact } from './artifacts';
import type { Operation, ViewerOperationContext } from './contract';
import { exportNativeSceneOperations } from './export-native-scenes';
import { exportNativeDataOperations } from './export-native-data';
import { exportNativeAnonymizedOperations } from './export-native-anonymized';
import { exportNativeViewOperations } from './export-native-view';
import { cityJsonExportOperations } from './model-cityjson';
import { cityJsonEngine } from '@/lib/export/native-cityjson';
import { nativeExportGuard } from './export-native-runtime';
import { nativeExportRegistryInventory } from './export-native-inventory';
import { EXPORT_COMMAND_IDS } from '@/components/viewer/toolbar/export-commands';
import { DEFAULT_RHINO_EXPORT_SETTINGS } from '@/components/viewer/rhino-export-options';
import { produceNativeViewPdf } from '@/lib/export/native-view-pdf';
import { DEFAULT_ANONYMIZE_TOGGLES } from '@/components/viewer/anonymized-export/AnonymizationOptionsPanel';
const entries: Operation[] = [...exportNativeSceneOperations, ...exportNativeDataOperations, ...exportNativeViewOperations, ...exportNativeAnonymizedOperations, ...cityJsonExportOperations];
let c: ViewerOperationContext;
beforeEach(async () => {
  resetFeaturesForTest(); await seedCoincidentWalls(2, 4);
  const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
  const commit = <T,>(write: () => T) => { c.signal?.throwIfAborted(); return write(); };
  c = { host, commit, commitAsync: async <T,>(write: () => Promise<T>) => write(), ownGeometry: async work => work(), retain: () => {}, artifacts: operationArtifacts(host, commit), canEdit: () => true };
});
async function run<T>(id: string, input: unknown): Promise<T> { const op = entries.find(entry => entry.id === id); assert.ok(op); const result = await op.execute(input, c); op.validateResult(JSON.parse(JSON.stringify(result))); return result as T; }
async function bytes(id: string) { const read = await readArtifact(c.host, id, 0, 65536); assert.equal(read.next_offset, null); return Buffer.from(read.data, 'base64'); }
const anon = { target_model_id: 'A', seed_ids: [1], excluded_ids: [], excluded_types: [], file_stem: 'anonymous',
  relations: { IfcRelVoidsElement: true, IfcRelFillsElement: true, IfcRelAggregates: 'both', IfcRelNests: 'down', IfcRelDefinesByType: true, IfcRelAssociatesMaterial: true, IfcRelContainedInSpatialStructure: true, IfcRelDefinesByProperties: false, IfcRelConnectsPathElementsDepth: 0 }, anonymize: { ...DEFAULT_ANONYMIZE_TOGGLES } };
describe('native export registry automation (#10525)', () => {
  it('accounts for every actual toolbar command with a native operation or explicit existing host boundary', () => {
    for (const id of EXPORT_COMMAND_IDS) { const row = nativeExportRegistryInventory.find(row => row.registry_id === id); assert.ok(row, id); assert.ok(row.operations.length || 'classification' in row, id); }
    for (const op of entries) assert.ok(nativeExportRegistryInventory.some(row => (row.operations as readonly string[]).includes(op.id)), op.id);
  });
  it('exports.cityjson refuses unknown models and models without a retained IFC source before loading the writer', async (t) => {
    const load = t.mock.method(cityJsonEngine, 'load');
    await assert.rejects(run('exports.cityjson', { target_model_id: 'missing', sequence: false }), /existing exportable model/);
    assert.equal(useViewerStore.getState().models.get('A')?.sourceFile, undefined);
    await assert.rejects(run('exports.cityjson', { target_model_id: 'A', sequence: true }), /retained \.ifc\/\.ifczip source/);
    assert.equal(load.mock.callCount(), 0);
  });
  it('exports.cityjson returns the producer output with its warnings and maps package refusals (#10796)', async (t) => {
    const models = new Map(useViewerStore.getState().models);
    models.set('A', { ...models.get('A')!, sourceFile: new File(['ISO-10303-21;'], 'a.ifc') });
    useViewerStore.setState({ models, georefMutations: new Map([['A', { mapConversion: { Eastings: 1 } }]]) as never });
    t.mock.method(cityJsonEngine, 'load', async () => ({
      exportCityJson: async (_bytes: Uint8Array, options: { sequence?: boolean }) => ({ text: options.sequence ? '{}\n' : '{"type":"CityJSON"}', warnings: ['no georef'] }),
      cityJsonRefusalReason: () => null,
    }));
    const result = await run<{ artifact: { artifact_id: string; filename: string; mime_type: string }; diagnostics_json: string }>('exports.cityjson', { target_model_id: 'A', sequence: false });
    assert.match(result.artifact.filename, /\.city\.json$/); assert.equal(result.artifact.mime_type, 'application/json');
    assert.equal((await bytes(result.artifact.artifact_id)).toString('utf8'), '{"type":"CityJSON"}');
    const { warnings } = JSON.parse(result.diagnostics_json) as { warnings: string[] };
    // The session MapConversion edit reaches the georeferencing phase; its refusal (no CRS to target) leads the producer's own warnings.
    assert.match(warnings[0], /Cannot create IfcMapConversion/); assert.deepEqual(warnings.slice(1), ['no georef']);
    t.mock.method(cityJsonEngine, 'load', async () => ({
      exportCityJson: async () => { throw new Error('raw'); }, cityJsonRefusalReason: () => 'The model has no IfcBuilding.',
    }));
    await assert.rejects(run('exports.cityjson', { target_model_id: 'A', sequence: true }), /no IfcBuilding/);
  });
  it('writes real single-model JSON entity bytes and refuses unknown/capture targets instead of mixing federation IDs (#10796)', async () => {
    const { models } = useViewerStore.getState();
    const otherStore = models.get('A')?.ifcDataStore;
    const store = models.get('B')?.ifcDataStore;
    assert.ok(otherStore);
    assert.ok(store);
    const other = new MutablePropertyView(otherStore.properties, 'A');
    configureMutationView(other, otherStore);
    other.setAttribute(1, 'Name', 'Other model wall', 'Wall 1');
    const view = new MutablePropertyView(store.properties, 'B');
    configureMutationView(view, store);
    view.setAttribute(1, 'Name', 'Revised exported wall', 'Wall 1');
    useViewerStore.setState({ mutationViews: new Map([['A', other], ['B', view]]) });
    const result = await run<{ artifact: { artifact_id: string }; diagnostics_json: string }>('exports.json', { target_model_id: 'B' });
    const parsed = JSON.parse((await bytes(result.artifact.artifact_id)).toString('utf8')) as { entities: Array<{ expressId: number; name: string }> };
    assert.equal(parsed.entities.find(row => row.expressId === 1)?.name, 'Revised exported wall');
    assert.ok(parsed.entities.every(row => row.name !== 'Other model wall'));
    assert.equal(parsed.entities.length, store.entities.expressId.length);
    assert.equal(JSON.parse(result.diagnostics_json).model_id, 'B');
    await assert.rejects(run('exports.json', { target_model_id: 'absent' }), /existing exportable model/);
    assert.equal(useViewerStore.getState().models.size, 2);
    useViewerStore.setState({ models: new Map(), ifcDataStore: store, activeModelId: null });
    const legacy = await run<{ artifact: { artifact_id: string } }>('exports.json', { target_model_id: '__legacy__' });
    assert.match((await bytes(legacy.artifact.artifact_id)).toString('utf8'), /Wall/);
  });
  it('passes the native USD bytes directly to the artifact Blob (#10795 item 69)', async (t) => {
    const models = new Map(useViewerStore.getState().models);
    models.set('A', { ...models.get('A')!, sourceFile: new File(['ISO-10303-21;'], 'a.ifc') });
    useViewerStore.setState({ models });
    const usd = new TextEncoder().encode('#usda 1.0');
    t.mock.method(GeometryProcessor.prototype, 'init', async () => {});
    t.mock.method(GeometryProcessor.prototype, 'exportUsd', () => usd);
    const OriginalBlob = globalThis.Blob;
    const seen: BlobPart[] = [];
    const RecordingBlob = class extends OriginalBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        if (options?.type === 'text/plain' && parts) seen.push(...parts);
      }
    };
    globalThis.Blob = RecordingBlob;
    try {
      const result = await run<{ artifact: { artifact_id: string } }>('exports.usd', { target_model_id: 'A' });
      assert.equal((await bytes(result.artifact.artifact_id)).toString('utf8'), '#usda 1.0');
      assert.equal(seen[0], usd);
    } finally {
      globalThis.Blob = OriginalBlob;
    }
  });
  it('refuses anonymization preview when the store has no original STEP bytes (#10795 item 73)', async () => {
    const models = new Map(useViewerStore.getState().models);
    const model = models.get('A')!;
    models.set('A', { ...model, ifcDataStore: { ...model.ifcDataStore!, source: EMPTY_SOURCE_BYTES } });
    useViewerStore.setState({ models });
    await assert.rejects(run('exports.anonymized.prepare', anon), {
      code: 'UNSUPPORTED_OPERATION', details: { reason: 'unavailable' }, message: /original IFC STEP source bytes/,
    });
  });
  it('produces a native anonymized IFC, verifies membership before export and preserves source bytes', async () => {
    const store = useViewerStore.getState().models.get('A')?.ifcDataStore; assert.ok(store);
    const source = new Uint8Array(store.source.materialize());
    const preview = await run<{ included_ids: number[]; locked_ids: number[] }>('exports.anonymized.prepare', anon);
    assert.ok(preview.included_ids.includes(1)); assert.ok(preview.locked_ids.includes(1));
    await assert.rejects(run('exports.anonymized', { ...anon, expected_included_ids: [] }), /changed since preview/);
    const result = await run<{ artifact: { artifact_id: string; filename: string }; diagnostics_json: string }>('exports.anonymized', { ...anon, expected_included_ids: preview.included_ids });
    assert.equal(result.artifact.filename, 'anonymous.ifc'); const ifc = (await bytes(result.artifact.artifact_id)).toString('utf8');
    assert.match(ifc, /ISO-10303-21/); assert.match(ifc, /IFCWALL/); assert.doesNotMatch(ifc, /Wall 1/);
    assert.deepEqual(new Uint8Array(store.source.materialize()), source); assert.ok(JSON.parse(result.diagnostics_json).entityCount > 0);
    await assert.rejects(run('exports.anonymized.prepare', { ...anon, excluded_ids: [1] }), /locked/);
    await assert.rejects(run('exports.anonymized.prepare', { ...anon, relations: { ...anon.relations, IfcRelDefinesByProperties: true } }), /coupled/);
  });
  it('refuses stale view settings and aborted export preparation before retaining bytes', () => {
    const check = nativeExportGuard(c, ['A']); check(); useViewerStore.setState({ hiddenEntities: new Set([1]) }); assert.throws(check, /changed/);
    const controller = new AbortController(); c.signal = controller.signal; controller.abort(); assert.throws(() => nativeExportGuard(c, ['A'])());
  });
  it('uses the genuine native vector PDF pipeline and captures completed PDF bytes without a browser download', async () => {
    const geometry = useViewerStore.getState().models.get('A')?.geometryResult; assert.ok(geometry?.meshes.length);
    const output = await produceNativeViewPdf({ view: { meshes: [...geometry.meshes], instancedMeshes: [], hiddenEntities: new Set(), isolatedEntities: null, computedIsolatedIds: null, typeVisibility: useViewerStore.getState().typeVisibility, modelVisibility: null },
      camera: { position: { x: 5, y: 5, z: 5 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, projectionMode: 'orthographic' }, section: null, scaleFactor: 100, renderMode: 'lines', includeScaleStamp: true });
    assert.ok(output.result.strokeCount > 0); assert.ok(output.result.page.widthMm > 0); assert.match(Buffer.from(await output.blob.arrayBuffer()).subarray(0, 8).toString('latin1'), /^%PDF-/);
  });
  it('rejects oversized numerical PDF scales and distinguishes an empty view (#11060)', async t => {
    const camera = {
      getPosition: () => ({ x: 50, y: 50, z: 200 }),
      getTarget: () => ({ x: 50, y: 50, z: 0 }),
      getUp: () => ({ x: 0, y: 1, z: 0 }),
      getProjectionMode: () => 'orthographic',
      getOrthoSize: () => 120,
      getDistance: () => 200,
      getFOV: () => Math.PI / 4,
      getSceneBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 100 } }),
    };
    const renderer = {
      getCamera: () => camera,
      getScene: () => ({ getAllInstancedMeshData: () => [] }),
    } as unknown as Renderer;
    setGlobalRendererRef({ current: renderer });
    t.after(clearGlobalRefs);

    const models = new Map(useViewerStore.getState().models);
    for (const [id, model] of models) {
      const geometry = model.geometryResult;
      assert.ok(geometry);
      // Enlarge the fixture's real box mesh to span 100 metres.
      const meshes = geometry.meshes.map(mesh => ({ ...mesh, positions: mesh.positions.map(value => value * 100) }));
      models.set(id, { ...model, geometryResult: { ...geometry, meshes } });
    }
    useViewerStore.setState({ models });
    const exportPdf = (scale: number) => dispatchMainViewerTool(c.host, 'viewer_operation_execute', {
      operation_id: 'exports.viewPdf',
      input: {
        scope: 'current-view', scale_mode: 'numerical', scale,
        include_hidden_lines: false, render_mode: 'lines', include_scale_stamp: true,
      },
    }, { canEdit: () => true });

    const oversized = await exportPdf(1);
    assert.equal(oversized.errorCode, 'INVALID_INPUT', oversized.text);
    assert.equal((oversized.structured as { reason: string }).reason, 'limit');
    assert.match(oversized.text, /larger scale denominator/i);

    const printable = await exportPdf(1000);
    assert.equal(printable.isError, false, printable.text);
    const { result } = printable.structured as { result: { artifact: { artifact_id: string } } };
    assert.match((await bytes(result.artifact.artifact_id)).toString('latin1'), /^%PDF-/);

    useViewerStore.setState({ models: new Map([...models].map(([id, model]) => [id, { ...model, visible: false }])) });
    const empty = await exportPdf(1);
    assert.equal(empty.errorCode, 'UNSUPPORTED_OPERATION', empty.text);
    assert.equal((empty.structured as { reason: string }).reason, 'unavailable');
  });
  it('rejects an unsupported Rhino version with otherwise valid settings (#10796)', async () => {
    await assert.rejects(run('exports.rhino', {
      target_model_id: 'A', settings: { ...DEFAULT_RHINO_EXPORT_SETTINGS, version: 99 },
    }), /Invalid exports\.rhino input/);
  });
  it('rejects unavailable native camera and unsupported terrain targets before emitting an artifact', async () => {
    await assert.rejects(run('exports.viewPdf', { scope: 'current-view', scale_mode: 'numerical', scale: 100, include_hidden_lines: false, render_mode: 'lines', include_scale_stamp: true }), /camera/);
    await assert.rejects(run('exports.terrainLandXml', { target_model_id: 'A', express_ids: [1], linear_unit: 'metre', decimals: 3, surface_names: [] }), /IfcGeographicElement/);
  });
});
