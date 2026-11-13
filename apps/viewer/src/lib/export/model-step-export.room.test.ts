/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { parseFixtureModel, FIXTURE_PROJECT, FIXTURE_SITE, FIXTURE_BUILDING, FIXTURE_WALL_A } from '@/components/viewer/anonymized-export/anonymized-export-fixture.test-support';
import { tabularFixtureStore, PROXY_A, PROXY_B, WALL } from '@/test/tabular-store-fixture';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { registerRoomSymbolicSource } from '@/lib/collab/room-symbolic-source';
import { exportModelStep } from './model-step-export';
import { roomMergeInput } from '@/lib/collab/room-merged-export';

const OPTIONS = { schema: 'IFC4', applyMutations: true } as const;

/** Matches the STEP-records refusal by its public shape, through the entry points that throw it. */
function refusal(reason: 'roomMoved' | 'noRecords', modelName?: string) {
  return (error: unknown) => {
    const refused = error as Error & { reason?: string; modelName?: string };
    return refused instanceof Error && refused.name === 'StepRecordsUnavailableError' && refused.reason === reason
      && (modelName === undefined || refused.modelName === modelName);
  };
}

async function parse(content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** A tabular room store (three roots) with a portable STEP source owning `owned` of them. */
async function roomStore(owned: ReadonlyArray<readonly [number, number]>): Promise<IfcDataStore> {
  const room = tabularFixtureStore({ source: new TextEncoder().encode('{"not":"step"}').buffer as ArrayBuffer });
  const portable = await parseFixtureModel();
  registerRoomSymbolicSource(room, {
    dataStore: portable,
    source: portable.source,
    seededIds: new Set(owned.map(([sourceId]) => sourceId)),
    ownerIds: new Map(owned),
    placements: new Map(),
    baselines: new Map(),
    structuredPsets: new Map(),
    structuredQuantities: new Map(),
    structuredAttributes: new Map(),
  });
  return room;
}

test('a room whose root set moved past its portable source refuses STEP export (#10045)', async () => {
  // The room holds WALL, which the portable source does not own.
  const dataStore = await roomStore([[FIXTURE_PROJECT, PROXY_A], [FIXTURE_SITE, PROXY_B]]);
  // A rejection is the whole outcome: no content is returned to download.
  await assert.rejects(
    exportModelStep({ modelId: 'room', dataStore, options: OPTIONS, scheduleState: null }),
    refusal('roomMoved'),
  );
});

test('a tabular store with no portable source refuses STEP export (#10045)', async () => {
  await assert.rejects(
    exportModelStep({ modelId: 'ifcx', dataStore: tabularFixtureStore(), options: OPTIONS, scheduleState: null }),
    refusal('noRecords'),
  );
});

test('a room still covered by its portable source writes from that source (#10045)', async () => {
  const dataStore = await roomStore([[FIXTURE_PROJECT, PROXY_A], [FIXTURE_SITE, PROXY_B], [FIXTURE_BUILDING, WALL]]);
  const result = await exportModelStep({ modelId: 'room', dataStore, options: OPTIONS, scheduleState: null });
  const exported = await parse(result.content);
  assert.equal(exported.entities.getName(FIXTURE_WALL_A), 'Wall A', 'records come from the portable STEP source');
  assert.equal(exported.entityIndex.byId.has(FIXTURE_PROJECT), true);
});

test('an applied edit outside the portable source refuses the export (#10045)', async () => {
  const dataStore = await roomStore([[FIXTURE_PROJECT, PROXY_A], [FIXTURE_SITE, PROXY_B], [FIXTURE_BUILDING, WALL]]);
  const mutationView = new MutablePropertyView(dataStore.properties ?? null, 'room');
  mutationView.setAttribute(999, 'Name', 'Local only');
  await assert.rejects(
    exportModelStep({ modelId: 'room', dataStore, mutationView, options: OPTIONS, scheduleState: null }),
    refusal('roomMoved'),
  );
});

test('the merged path refuses with the model named (#10045)', async () => {
  const moved = await roomStore([[FIXTURE_PROJECT, PROXY_A], [FIXTURE_SITE, PROXY_B]]);
  for (const [store, reason] of [[moved, 'roomMoved'], [tabularFixtureStore(), 'noRecords']] as const) {
    assert.throws(
      () => roomMergeInput({ id: 'm', name: 'Model M', store, applyMutations: true }),
      refusal(reason, 'Model M'),
    );
  }
  const step = await parseFixtureModel();
  assert.equal(roomMergeInput({ id: 's', name: 'S', store: step, applyMutations: true }).input.dataStore, step);
});

test('a plain STEP model still exports from its own records (#10045)', async () => {
  const result = await exportModelStep({ modelId: 'step', dataStore: await parseFixtureModel(), options: OPTIONS, scheduleState: null });
  const exported = await parse(result.content);
  assert.equal(exported.entities.getName(FIXTURE_WALL_A), 'Wall A');
});

test('the dialog message names the refused model through its catalogue key and passes other failures through (#10045)', async () => {
  // Loaded at run time: main has no such export, so a static named import would stop this file loading without this change.
  const { exportFailureMessage } = await import('./model-step-export');
  const t = (key: string, params: { model: string }) => `${key}|${params.model}`;
  const moved = await exportModelStep({
    modelId: 'room', dataStore: await roomStore([[FIXTURE_PROJECT, PROXY_A], [FIXTURE_SITE, PROXY_B]]), options: OPTIONS, scheduleState: null,
  }).catch((error: unknown) => error);
  assert.ok(refusal('roomMoved')(moved), 'the moved room refuses');
  assert.equal(exportFailureMessage(moved, t, 'Selected'), 'exportDialog.stepRecords.roomMoved|Selected');
  const merged = await Promise.resolve()
    .then(() => roomMergeInput({ id: 'm', name: 'Merged A', store: tabularFixtureStore(), applyMutations: true }))
    .catch((error: unknown) => error);
  assert.ok(refusal('noRecords', 'Merged A')(merged), 'the merged tabular store refuses');
  assert.equal(exportFailureMessage(merged, t, 'Selected'), 'exportDialog.stepRecords.noRecords|Merged A', 'the refused merged model wins over the selection');
  assert.equal(exportFailureMessage(new Error('boom'), t), 'Export failed: boom');
});
