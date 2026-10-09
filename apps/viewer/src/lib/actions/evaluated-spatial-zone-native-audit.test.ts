/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import type { Renderer } from '@ifc-lite/renderer';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import { Scene } from '../../../../../packages/renderer/src/scene';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { recomputeZoneAssignmentsNow } from '@/hooks/useZoneAssignmentSync';
import { emitSpatialZones, zoneSetMarker, type ZoneMembership } from '@/lib/zones/emit-spatial-zones';
import { firstEffectiveStoreyId } from '@/lib/first-effective-storey';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { recordModellingEdit, modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { seedZoneExport } from '@/test/zone-export-fixture';
import { parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';
const initial = useViewerStore.getState();
afterEach(() => { setGlobalRendererRef({ current: null }); useViewerStore.setState(initial, true); });
async function nativeEvaluation(t: TestContext) {
  if (!ensureWasm(t)) return null;
  const f = await seedZoneExport();
  useViewerStore.setState({ editEnabled: true, collabRole: null, collabRoomId: null, storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), removedNewEntities: new Map(), removedMeshes: new Map(), dirtyModels: new Set(), mutationVersion: 0 });
  const scene = new Scene(); for (const mesh of f.meshes) scene.addMeshData(mesh);
  setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer });
  recomputeZoneAssignmentsNow();
  assert.ok(useViewerStore.getState().zoneAssignmentTiming?.elementCount, 'native CPU Scene and real WASM geometry drive the evaluation');
  assert.deepEqual(useViewerStore.getState().zoneAssignments.get(f.wall.expressId)?.[f.zoneSet.id].touchedZoneIds, ['whole']);
  const target = modelEditTarget(useViewerStore.getState(), 'bonsai'); assert.ok(target);
  const storeyId = firstEffectiveStoreyId(f.store, target.view); assert.ok(storeyId);
  const members: ZoneMembership[] = [...useViewerStore.getState().zoneAssignments].flatMap(([expressId, rows]) => rows[f.zoneSet.id]?.touchedZoneIds.length ? [{ expressId, touchedZoneIds: rows[f.zoneSet.id].touchedZoneIds }] : []);
  return { ...f, ...target, storeyId, members };
}
test('Campaign6812 real Bonsai evaluated SpatialZone emission exports native references, replaces only current marked outputs and supports native transaction Undo', async t => {
  const f = await nativeEvaluation(t); if (!f) return;
  const run = (name: string) => recordModellingEdit(useViewerStore, 'bonsai', (_methods, draft) => emitSpatialZones(draft, f.store, { ...f.zoneSet, name }, f.members, {}, { view: draft.getMutationView(), storeyId: f.storeyId }), name);
  const one = run('First evaluated zones'); assert.equal(one.refusal, null); assert.equal(one.zonesEmitted, 1);
  const saved = await parseIfc(editedModelBytes(f.store, f.view));
  const zoneIds = [...saved.entityIndex.byType.get('IFCSPATIALZONE') ?? []]; assert.equal(zoneIds.length, 1);
  const first = effectiveMetadataRecord(saved, zoneIds[0]); assert.ok(first); assert.equal(first.attributes[3], zoneSetMarker(f.zoneSet.id)); assert.equal(first.attributes[7], 'First evaluated zones');
  const relationship = [...saved.entityIndex.byType.get('IFCRELREFERENCEDINSPATIALSTRUCTURE') ?? []].map(id => effectiveMetadataRecord(saved, id)!).find(row => row.attributes[5] === zoneIds[0]); assert.ok(relationship);
  assert.ok((relationship.attributes[4] as number[]).includes(f.wall.expressId), 'exported native relationship references the genuinely evaluated Bonsai wall');
  assert.deepEqual(danglingReferences(new TextDecoder().decode(editedModelBytes(f.store, f.view))), []);
  const second = run('Renamed evaluated zones'); assert.equal(second.zonesReplaced, 1); assert.equal(second.zonesEmitted, 1);
  const renamed = await parseIfc(editedModelBytes(f.store, f.view)); assert.equal(renamed.entityIndex.byType.get('IFCSPATIALZONE')?.length, 1);
  useViewerStore.getState().undo('bonsai');
  const undone = await parseIfc(editedModelBytes(f.store, f.view)); const restored = effectiveMetadataRecord(undone, undone.entityIndex.byType.get('IFCSPATIALZONE')![0]); assert.equal(restored?.attributes[0], first.attributes[0]); assert.equal(restored?.attributes[7], 'First evaluated zones');
  useViewerStore.getState().undo('bonsai'); assert.equal((await parseIfc(editedModelBytes(f.store, f.view))).entityIndex.byType.get('IFCSPATIALZONE')?.length ?? 0, 0);
});
test('Campaign6812 evaluated SpatialZone native refusal preserves source and native history for alignment, no members and degenerate set', async t => {
  const f = await nativeEvaluation(t); if (!f) return;
  const before = editedModelBytes(f.store, f.view), count = useViewerStore.getState().undoStacks.get('bonsai')?.length;
  for (const refusal of ['rescaled-by-alignment', 'no-members', 'degenerate-zone']) {
    const set = refusal === 'degenerate-zone' ? { ...f.zoneSet, zones: [{ ...f.zoneSet.zones[0], size: [0, 1, 1] as [number, number, number] }] } : f.zoneSet;
    const outcome = emitSpatialZones(f.editor, f.store, set, refusal === 'no-members' ? [] : f.members, {}, { view: f.view, storeyId: f.storeyId, rebased: refusal === 'rescaled-by-alignment' });
    assert.equal(outcome.refusal, refusal); assert.deepEqual(editedModelBytes(f.store, f.view), before); assert.equal(useViewerStore.getState().undoStacks.get('bonsai')?.length, count);
  }
});
test('Campaign6812 existing genuine evaluated native SpatialZone result is missing from reviewed authoring admission', async t => {
  const f = await nativeEvaluation(t); if (!f) return;
  const native = recordModellingEdit(useViewerStore, 'bonsai', (_methods, draft) => emitSpatialZones(draft, f.store, f.zoneSet, f.members, {}, { view: draft.getMutationView(), storeyId: f.storeyId }), 'native emission witness');
  assert.equal(native.refusal, null); assert.equal((await parseIfc(editedModelBytes(f.store, f.view))).entityIndex.byType.get('IFCSPATIALZONE')?.length, 1);
  assert.doesNotThrow(() => parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Review current evaluated zone set', units: 'm', frame: 'storey-local', operations: [{ op: 'zone.emit', modelId: 'bonsai', zoneSetId: f.zoneSet.id }] })), 'real evaluated native zone-set emission needs a reviewed route; no membership or geometry is supplied by the provider');
});
