/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import type { Renderer } from '@ifc-lite/renderer';
import { Scene } from '../../../../../packages/renderer/src/scene';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { recomputeZoneAssignmentsNow } from '@/hooks/useZoneAssignmentSync';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { seedZoneExport } from '@/test/zone-export-fixture';
import { captureSelectionGrounding } from './selection-grounding';
import { captureEvidence } from '../assistant/evidence';

const initial = useViewerStore.getState();
afterEach(() => { setGlobalRendererRef({ current: null }); useViewerStore.setState(initial, true); });

test('#7322 complete native Zone pins preserve the ordinary selected row within the existing transport budget', async t => {
  if (!ensureWasm(t)) return;
  const f = await seedZoneExport();
  const model = useViewerStore.getState().models.get('bonsai')!;
  useViewerStore.setState({ models: new Map([['bonsai', { ...model, idOffset: 0, maxExpressId: Math.max(...f.store.entityIndex.byId.keys()) }]]),
    editEnabled: true, collabRole: null, collabRoomId: null, storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(),
    mutationBatchTags: new Map(), removedNewEntities: new Map(), removedMeshes: new Map(), dirtyModels: new Set(), mutationVersion: 0,
    zoneSets: [{ ...f.zoneSet, zones: Array.from({ length: 75 }, (_, index) => ({ ...f.zoneSet.zones[0],
      id: `zone-${index}-${'I'.repeat(140)}`, name: `Zone ${index} ${'A'.repeat(230)}` })) }] });
  const scene = new Scene(); f.meshes.forEach(mesh => scene.addMeshData(mesh));
  setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer });
  useViewerStore.getState().addEntityToSelection({ modelId: 'bonsai', expressId: f.wall.expressId });
  useViewerStore.getState().setSelectedEntityIds([f.wall.expressId]);
  recomputeZoneAssignmentsNow();
  const state = useViewerStore.getState();
  const native = captureSelectionGrounding(state).elements[0]?.nativeZoneEmission;
  assert.ok(native, 'native selection publishes the Zone evidence contract');
  assert.equal(native?.status, 'available-targets', 'the bounded actual native Zone population is available before transport');
  const envelope = JSON.parse(captureEvidence('selection').payload);
  assert.equal(envelope.includedRows, 1, 'optional Zone snapshot bytes cannot erase the ordinary native wall row');
  assert.equal(envelope.evidence.rows[0]?.data.expressId, f.wall.expressId);
  const transported = envelope.evidence.rows[0]?.data.nativeZoneEmission;
  assert.equal(transported?.status, native.status);
  assert.equal(transported?.choices.length, native.choices.length);
  for (const [index, choice] of native.choices.entries()) {
    assert.equal(transported.choices[index].status, choice.status);
    assert.equal(transported.choices[index].expectedJsonParts?.join('') ?? null,
      choice.expected ? JSON.stringify(choice.expected) : null, 'an available native target retains its complete approval snapshot');
  }
  assert.equal(state.mutationViews.size, 0, 'native evidence capture creates no persistent edit view');
});
