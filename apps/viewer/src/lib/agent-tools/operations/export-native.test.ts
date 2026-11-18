/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { resetFeaturesForTest } from '@/lib/features';
import { createMainViewerToolHost } from '../main-viewer-host';
import { operationArtifacts, readArtifact } from './artifacts';
import type { Operation, ViewerOperationContext } from './contract';
import { exportNativeSceneOperations } from './export-native-scenes';
import { exportNativeDataOperations } from './export-native-data';
import { exportNativeAnonymizedOperations } from './export-native-anonymized';
import { exportNativeViewOperations } from './export-native-view';
import { cityJsonExportOperations } from './model-cityjson';
import { nativeExportGuard } from './export-native-runtime';
import { nativeExportRegistryInventory } from './export-native-inventory';
import { EXPORT_COMMAND_IDS } from '@/components/viewer/toolbar/export-commands';
import { produceNativeViewPdf } from '@/lib/export/native-view-pdf';
import { DEFAULT_ANONYMIZE_TOGGLES } from '@/components/viewer/anonymized-export/AnonymizationOptionsPanel';
const entries: Operation[] = [...exportNativeSceneOperations, ...exportNativeDataOperations, ...exportNativeViewOperations, ...exportNativeAnonymizedOperations, ...cityJsonExportOperations];
let c: ViewerOperationContext;
beforeEach(async () => {
  resetFeaturesForTest(); await seedCoincidentWalls(2, 4);
  const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
  const commit = <T,>(write: () => T) => { c.signal?.throwIfAborted(); return write(); };
  c = { host, commit, commitAsync: async <T,>(write: () => Promise<T>) => write(), artifacts: operationArtifacts(host, commit), canEdit: () => true };
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
  it('exports.cityjson refuses unknown models and models without a retained IFC source before loading the writer', async () => {
    await assert.rejects(run('exports.cityjson', { target_model_id: 'missing', sequence: false }), /Unknown loaded native model/);
    assert.equal(useViewerStore.getState().models.get('A')?.sourceFile, undefined);
    await assert.rejects(run('exports.cityjson', { target_model_id: 'A', sequence: true }), /retained \.ifc\/\.ifczip source/);
  });
  it('writes real single-model JSON entity bytes and refuses unknown/capture targets instead of mixing federation IDs', async () => {
    const store = useViewerStore.getState().models.get('B')?.ifcDataStore; assert.ok(store);
    const view = new MutablePropertyView(store.properties ?? null, 'B'); configureMutationView(view, store); view.setAttribute(1, 'Name', 'Revised exported wall', 'Wall 1');
    useViewerStore.setState({ mutationViews: new Map([['B', view]]) });
    const result = await run<{ artifact: { artifact_id: string }; diagnostics_json: string }>('exports.json', { target_model_id: 'B' });
    const parsed = JSON.parse((await bytes(result.artifact.artifact_id)).toString('utf8')) as { entities: { Name?: string; name?: string }[] };
    assert.ok(parsed.entities.length > 0); assert.match(JSON.stringify(parsed), /Revised exported wall/); assert.equal(JSON.parse(result.diagnostics_json).model_id, 'B');
    await assert.rejects(run('exports.json', { target_model_id: 'absent' }), /existing exportable model/);
    assert.equal(useViewerStore.getState().models.size, 2);
    useViewerStore.setState({ models: new Map(), ifcDataStore: store, activeModelId: null });
    const legacy = await run<{ artifact: { artifact_id: string } }>('exports.json', { target_model_id: '__legacy__' });
    assert.match((await bytes(legacy.artifact.artifact_id)).toString('utf8'), /Wall/);
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
  it('rejects malformed native control options and unavailable native camera before a placeholder artifact can be emitted', async () => {
    await assert.rejects(run('exports.rhino', { target_model_id: 'A', settings: { version: 99 } }));
    await assert.rejects(run('exports.viewPdf', { scope: 'current-view', scale_mode: 'numerical', scale: 100, include_hidden_lines: false, render_mode: 'lines', include_scale_stamp: true }), /camera/);
    await assert.rejects(run('exports.terrainLandXml', { target_model_id: 'A', express_ids: [1], linear_unit: 'metre', decimals: 3, surface_names: [] }), /IfcGeographicElement/);
  });
});
