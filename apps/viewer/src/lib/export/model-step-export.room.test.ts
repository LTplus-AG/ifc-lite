/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { parseFixtureModel, FIXTURE_PROJECT, FIXTURE_SITE, FIXTURE_BUILDING, FIXTURE_WALL_A } from '@/components/viewer/anonymized-export/anonymized-export-fixture.test-support';
import { tabularFixtureStore, PROXY_A, PROXY_B, WALL } from '@/test/tabular-store-fixture';
import { registerRoomSymbolicSource } from '@/lib/collab/room-symbolic-source';
import { StepRecordsUnavailableError } from '@/lib/collab/room-step-export';
import { exportModelStep } from './model-step-export';

const OPTIONS = { schema: 'IFC4', applyMutations: true } as const;

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
  let result: Awaited<ReturnType<typeof exportModelStep>> | undefined;
  await assert.rejects(
    (async () => { result = await exportModelStep({ modelId: 'room', dataStore, options: OPTIONS, scheduleState: null }); })(),
    (error: unknown) => error instanceof StepRecordsUnavailableError && error.reason === 'roomMoved',
  );
  assert.equal(result, undefined, 'no file content is produced');
});

test('a tabular store with no portable source refuses STEP export (#10045)', async () => {
  await assert.rejects(
    exportModelStep({ modelId: 'ifcx', dataStore: tabularFixtureStore(), options: OPTIONS, scheduleState: null }),
    (error: unknown) => error instanceof StepRecordsUnavailableError && error.reason === 'noRecords',
  );
});

test('a room still covered by its portable source writes from that source (#10045)', async () => {
  const dataStore = await roomStore([[FIXTURE_PROJECT, PROXY_A], [FIXTURE_SITE, PROXY_B], [FIXTURE_BUILDING, WALL]]);
  const result = await exportModelStep({ modelId: 'room', dataStore, options: OPTIONS, scheduleState: null });
  const exported = await parse(result.content);
  assert.equal(exported.entities.getName(FIXTURE_WALL_A), 'Wall A', 'records come from the portable STEP source');
  assert.equal(exported.entityIndex.byId.has(FIXTURE_PROJECT), true);
});

test('a plain STEP model still exports from its own records (#10045)', async () => {
  const result = await exportModelStep({ modelId: 'step', dataStore: await parseFixtureModel(), options: OPTIONS, scheduleState: null });
  const exported = await parse(result.content);
  assert.equal(exported.entities.getName(FIXTURE_WALL_A), 'Wall A');
});
