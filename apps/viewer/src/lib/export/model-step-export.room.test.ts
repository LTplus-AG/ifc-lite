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
import { stepRecordsUnavailableReason } from './step-records-reason';

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
  const store = tabularFixtureStore();
  assert.equal(stepRecordsUnavailableReason(store), 'noRecords');
  await assert.rejects(
    exportModelStep({ modelId: 'ifcx', dataStore: store, options: OPTIONS, scheduleState: null }),
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

test('#9296: automatic drawing export remaps a portable room storey', async () => {
  const { useViewerStore } = await import('@/store');
  const modelId = 'portable-drawing';
  const { IfcCreator } = await import('@ifc-lite/create');
  const creator = new IfcCreator({ Name: 'Portable annotations', Schema: 'IFC4', Timestamp: 0 });
  const level = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  creator.addIfcWindow(level, { Name: 'Window mark', Position: [1, 2, 0], Width: 1.2, Height: 1.5 });
  creator.addIfcWall(level, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
  const portable = await parse(creator.toIfc().content);
  const sourceStorey = portable.entityIndex.byType.get('IFCBUILDINGSTOREY')![0];
  const sourceWindow = portable.entityIndex.byType.get('IFCWINDOW')![0];
  const sourceWall = portable.entityIndex.byType.get('IFCWALL')![0];
  const { tabularFixtureTables } = await import('@/test/tabular-store-fixture');
  const { buildTabularDataStore } = await import('@ifc-lite/parser');
  const tables = tabularFixtureTables();
  const { EntityTableBuilder } = await import('@ifc-lite/data');
  const table = new EntityTableBuilder(3, tables.strings);
  table.add(PROXY_A, 'IfcBuildingStorey', '0aBcDeFgHiJkLmNoPqRs01', 'Ground', '', '', true);
  table.add(PROXY_B, 'IfcWindow', '0aBcDeFgHiJkLmNoPqRs02', 'Window mark', '', '', true);
  table.add(WALL, 'IfcWall', '0aBcDeFgHiJkLmNoPqRs03', 'Wall', '', '', true);
  const dataStore = buildTabularDataStore({ ...tables, entities: table.build() }, {
    schemaVersion: 'IFC4', source: new TextEncoder().encode('{"not":"step"}').buffer as ArrayBuffer,
    fileSize: 4096, parseTime: 0, lengthUnitScale: 1, lengthUnitSource: 'declared',
  });
  const ownership: [number, number][] = [[sourceStorey, PROXY_A], [sourceWindow, PROXY_B], [sourceWall, WALL]];
  registerRoomSymbolicSource(dataStore, { dataStore: portable, source: portable.source,
    seededIds: new Set(ownership.map(([id]) => id)), ownerIds: new Map(ownership), placements: new Map(),
    baselines: new Map(), structuredPsets: new Map(), structuredQuantities: new Map(), structuredAttributes: new Map() });
  const { fixtureModel } = await import('@/test/store-fixture');
  const previous = useViewerStore.getState();
  useViewerStore.setState({ models: new Map([[modelId, { ...fixtureModel(modelId), ifcDataStore: dataStore }]]), activeModelId: modelId, activeStorey: { modelId, expressId: PROXY_A },
    drawing2DPlane: { axis: 'down', position: 1, flipped: false },
    measure2DResults: [{ id: 'portable-measure', start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, distance: 5 }],
    dimensions2D: [], tagAnnotations2D: [{ id: 'portable-tag', modelId, entityId: PROXY_B, anchor: { x: 1, y: 1 }, offset: { x: 0, y: 0 }, template: 'auto' }] });
  try {
    const result = await exportModelStep({ modelId, dataStore, options: OPTIONS, scheduleState: null });
    const exported = await parse(result.content);
    const annotations = exported.entityIndex.byType.get('IFCANNOTATION') ?? [];
    assert.equal(annotations.length, 2);
    const { effectiveMetadataRecord } = await import('@ifc-lite/parser');
    const containment = (exported.entityIndex.byType.get('IFCRELCONTAINEDINSPATIALSTRUCTURE') ?? [])
      .map(id => effectiveMetadataRecord(exported, id)!.attributes)
      .find(attrs => Array.isArray(attrs[4]) && attrs[4].includes(annotations[0]));
    assert.equal(containment?.[5], sourceStorey, 'containment uses the portable source storey, not the viewer id');
    const relationship = exported.entityIndex.byType.get('IFCRELASSIGNSTOPRODUCT')![0];
    assert.equal(effectiveMetadataRecord(exported, relationship)?.attributes[6], sourceWindow, 'the tag binds the source window, not viewer #2');
    useViewerStore.setState({ activeStorey: { modelId, expressId: 999999 } });
    const stale = await exportModelStep({ modelId, dataStore, mutationView: undefined, options: OPTIONS, scheduleState: null });
    const fallback = await parse(stale.content);
    assert.equal(fallback.entityIndex.byType.get('IFCANNOTATION')?.length, 2, 'unmapped active storey retains measurements and bound tags');

  } finally { useViewerStore.setState(previous, true); }
});
