/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { rectangularGridAxes } from '@ifc-lite/create';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { meshStairs, stairMeshBounds, stairWasmAvailable } from '../../../../../packages/create/src/in-store/__test__/stair-mesh.oracle.js';
import { useViewerStore } from '@/store';
import { addGridIn } from '@/store/slices/mutation-curtain-grid';
import { addGridColumnIn } from '@/store/slices/mutation-grid-column';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample, parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { refId } from '../../../../../packages/create/src/in-store/host-geometry-frame.js';
import { AnchorEntityReader } from '../../../../../packages/create/src/in-store/resolve-anchor.js';
import { parseModelAuthoringBatch } from './model-authoring';
import { authoringGhosts } from './model-authoring-ghost';
import { captureSelectionGrounding } from './selection-grounding';
import { captureEvidence } from '@/lib/assistant/evidence';
import { nativeReadTargets } from './model-authoring-read-target';
import { useAssistant, replaceEvidence, cancelAssistant } from '@/lib/assistant/conversation';
import { sendAssistant } from '@/lib/assistant/request';
import { selectionGroundingText } from './selection-grounding';
import { nativeGridEvidence } from './native-grid-evidence';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { resolveGlobalId } from './resolve-global-id';
import { undoModelChanges } from './model-change-commit';

const initial = useViewerStore.getState(), initialAssistant = useAssistant.getState(), initialFetch = globalThis.fetch;
afterEach(() => { cancelAssistant(); useViewerStore.setState(initial); useAssistant.setState(initialAssistant); globalThis.fetch = initialFetch; });
const params = { Position: [0, 0, 0] as [number, number, number], Direction: 0,
  ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }), Name: 'Native source design grid' };
const batch = (operations: unknown[]) => JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native grid review', units: 'm', frame: 'storey-local', operations });

async function nativeGrid() {
  const { dataStore, view } = await seedAuthoringSample();
  const storey = resolveGlobalId(useViewerStore.getState(), { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL });
  assert.ok(typeof storey === 'object');
  const made = addGridIn(useViewerStore, SAMPLE_MODEL, storey.expressId, params);
  assert.ok('expressId' in made, 'existing native grid builder is applicable to the actual SketchUp IFC storey');
  return { dataStore, view, storey, made };
}

for (const storage of ['live', 'saved'] as const) for (const route of ['attachment', 'rich'] as const) test(`#7304 ${storage} ${route} native nameless Grid evidence parses, applies a real bound column and undoes`, async () => {
  const native = await nativeGrid(), made = native.made;
  let { dataStore, view } = native;
  useViewerStore.getState().storeEditors.get(SAMPLE_MODEL)!.setAttribute(made.expressId, 'Name', '$');
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(new AnchorEntityReader(saved, null).entity(made.expressId)?.attributes[2], null,
    'public native writer and independent STEP parsing prove the valid absent EXPRESS Name');
  if (storage === 'saved') {
    dataStore = saved;
    view = new MutablePropertyView(saved.properties ?? null, SAMPLE_MODEL);
    const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
    useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: saved, maxExpressId: getMaxExpressId(saved, []) }]]),
      mutationViews: new Map([[SAMPLE_MODEL, view]]), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), dirtyModels: new Set() });
  }
  const rendererId = useViewerStore.getState().toGlobalId(SAMPLE_MODEL, made.expressId);
  useViewerStore.setState({ selectedEntityIds: new Set([rendererId]), selectedEntityId: rendererId,
    selectedEntity: { modelId: SAMPLE_MODEL, expressId: made.expressId }, selectedEntities: [], selectedEntitiesSet: new Set() });
  const row = route === 'attachment' ? captureSelectionGrounding(useViewerStore.getState()).elements[0]
    : JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data;
  assert.ok(row, 'the canonical renderer identity resolves to the native Grid');
  assert.equal(row.name, null); assert.equal(row.nativeGrid?.status, 'available');
  const proposal = parseModelAuthoringBatch(batch([{ op: 'column.createOnGrid', ref: 'unnamed-grid-column',
    storey: { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL },
    grid: { target: { globalId: row.globalId, modelId: row.modelId, ifcClass: row.type, name: row.name },
      expected: row.nativeGrid.expected, IntersectingAxes: [made.build.uAxisIds[1], made.build.vAxisIds[1]] },
    params: { Position: [6, 4, 0], Width: .4, Depth: .2, Height: 3 } }]));
  const revision = view.getMutationRevision();
  const preview = previewModelAuthoring(useViewerStore.getState(), proposal);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
  assert.equal(view.getMutationRevision(), revision, 'nameless-grid preflight is read-only');
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'native nameless grid');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const parsed = await parseIfc(editedModelBytes(dataStore, view)), read = new AnchorEntityReader(parsed, null);
  const columnId = parsed.entities.getExpressIdByGlobalId(outcome.receipt.applied[0].globalId);
  const local = read.entity(refId(read.entity(columnId)?.attributes[5])!)!;
  const placement = read.entity(refId(local.attributes[0])!)!;
  assert.equal(placement.type.toUpperCase(), 'IFCGRIDPLACEMENT');
  assert.deepEqual(read.entity(refId(placement.attributes[0])!)?.attributes[0], [made.build.uAxisIds[1], made.build.vAxisIds[1]]);
  assert.equal(read.entity(made.expressId)?.attributes[2], null, 'creation preserves the host Grid Name');
  assert.deepEqual(undoModelChanges(useViewerStore, outcome.receipt), { ok: true });
  const undone = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(undone.entities.getExpressIdByGlobalId(outcome.receipt.applied[0].globalId), -1);
  assert.equal(new AnchorEntityReader(undone, null).entity(made.expressId)?.attributes[2], null);
  const operation = proposal.operations[0];
  assert.equal(operation.op, 'column.createOnGrid');
  if (operation.op !== 'column.createOnGrid' || !('target' in operation.grid)) throw new Error('native existing-grid proposal required');
  const emptyInsteadOfAbsent = parseModelAuthoringBatch(batch([{ ...operation, grid: { ...operation.grid,
    target: { ...operation.grid.target, name: '' } } }]));
  const beforeRefusal = view.getMutationRevision();
  assert.notEqual(previewModelAuthoring(useViewerStore.getState(), emptyInsteadOfAbsent).rows[0].status, 'ready',
    'an explicit empty Name must not authorize a grid whose Name is absent');
  assert.equal(view.getMutationRevision(), beforeRefusal);
  useViewerStore.getState().storeEditors.get(SAMPLE_MODEL)!.setAttribute(made.expressId, 'Name', '');
  const empty = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(new AnchorEntityReader(empty, null).entity(made.expressId)?.attributes[2], '', 'native export preserves an explicit empty Name');
  const emptyRow = route === 'attachment' ? captureSelectionGrounding(useViewerStore.getState()).elements[0]
    : JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data;
  assert.equal(emptyRow.name, '', 'native transport preserves the actual empty Name instead of inventing absence');
  const emptyReview = previewModelAuthoring(useViewerStore.getState(), emptyInsteadOfAbsent);
  assert.equal(emptyReview.rows[0].status, 'ready', emptyReview.rows[0].issue ?? '');
});

test('P15A audit native grid and bound column preserve actual IFC relationships through export/reparse and Undo/Redo', async () => {
  const { dataStore, view, storey, made } = await nativeGrid();
  const first = useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0; assert.ok(first > 0);
  const gridTags = new Set((useViewerStore.getState().undoStacks.get(SAMPLE_MODEL) ?? []).map(row => useViewerStore.getState().mutationBatchTags.get(row.id)));
  assert.equal(gridTags.size, 1, 'complete native grid mutation history shares one undo batch');
  const column = addGridColumnIn(useViewerStore, SAMPLE_MODEL, storey.expressId, {
    Position: [6, 4, 0], Width: .4, Depth: .2, Height: 3, Name: 'Actual grid-bound column',
  }, { GridId: made.expressId, IntersectingAxes: [made.build.uAxisIds[1], made.build.vAxisIds[1]] });
  assert.ok('expressId' in column, 'existing native binding validates the actual current crossing');
  assert.ok((useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0) > first);
  const columnTags = new Set((useViewerStore.getState().undoStacks.get(SAMPLE_MODEL) ?? []).slice(first).map(row => useViewerStore.getState().mutationBatchTags.get(row.id)));
  assert.equal(columnTags.size, 1);
  assert.notEqual([...columnTags][0], [...gridTags][0]);
  const bytes = editedModelBytes(dataStore, view);
  const text = new TextDecoder().decode(bytes); assert.deepEqual(danglingReferences(text), []);
  const parsed = await parseIfc(bytes);
  const reader = new AnchorEntityReader(parsed, null);
  const grid = reader.entity(made.expressId); assert.equal(grid?.type.toUpperCase(), 'IFCGRID');
  assert.deepEqual(grid?.attributes[7], made.build.uAxisIds);
  assert.deepEqual(grid?.attributes[8], made.build.vAxisIds);
  const savedColumn = reader.entity(column.expressId); assert.equal(savedColumn?.type.toUpperCase(), 'IFCCOLUMN');
  const localId = refId(savedColumn?.attributes[5]); assert.ok(localId !== null);
  const local = reader.entity(localId); assert.equal(local?.type.toUpperCase(), 'IFCLOCALPLACEMENT');
  const placementId = refId(local?.attributes[0]); assert.ok(placementId !== null);
  const gridPlacement = reader.entity(placementId); assert.equal(gridPlacement?.type.toUpperCase(), 'IFCGRIDPLACEMENT');
  const crossingId = refId(gridPlacement?.attributes[0]); assert.ok(crossingId !== null);
  const intersection = reader.entity(crossingId); assert.equal(intersection?.type.toUpperCase(), 'IFCVIRTUALGRIDINTERSECTION');
  assert.deepEqual(intersection?.attributes[0], [made.build.uAxisIds[1], made.build.vAxisIds[1]]);
  useViewerStore.getState().undo(SAMPLE_MODEL);
  assert.equal(view.getNewEntity(column.expressId), null, 'native one-step Undo removes the complete new column edit');
  assert.ok(view.getNewEntity(made.expressId), 'earlier native grid edit remains');
  useViewerStore.getState().redo(SAMPLE_MODEL);
  assert.ok(view.getNewEntity(column.expressId), 'native Redo retains the original bound entity identity');
});

test('P15A audit actual native grid requires missing reviewed admission', async () => {
  const { made } = await nativeGrid();
  assert.ok(made.build.uAxisIds.length === 2 && made.build.vAxisIds.length === 2);
  assert.doesNotThrow(() => parseModelAuthoringBatch(batch([{ op: 'grid.create', ref: 'grid-one', storey: { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL }, params }])),
    'the native applicable grid has no standard reviewed authoring admission');
});


test('#7304 reviewed native grid and dependent column apply only approved rows and retain native STEP binding', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const proposal = parseModelAuthoringBatch(batch([
    { op: 'grid.create', ref: 'grid-one', storey: { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL }, params },
    { op: 'column.createOnGrid', ref: 'column-one', storey: { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL },
      grid: { ref: 'grid-one', IntersectingAxes: ['2', 'B'] }, params: { Position: [6, 4, 0], Width: .4, Depth: .2, Height: 3, Name: 'Reviewed bound column' } },
  ]));
  const before = view.getMutationRevision();
  const preview = previewModelAuthoring(useViewerStore.getState(), proposal);
  assert.deepEqual(preview.rows.map(row => [row.status, row.issue]), [['ready', undefined], ['ready', undefined]]);
  assert.equal(view.getMutationRevision(), before, 'native draft preflight cannot write the live view');
  const blocked = commitModelAuthoring(useViewerStore, preview, new Set([1]), 'unapproved grid dependency');
  assert.ok(!blocked.ok); assert.equal(view.getMutationRevision(), before);
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0, 1]), 'reviewed native grid');
  assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  assert.equal(result.receipt.applied.length, 2);
  const bytes = editedModelBytes(dataStore, view); assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)), []);
  const parsed = await parseIfc(bytes), reader = new AnchorEntityReader(parsed, null);
  const columnId = parsed.entities.getExpressIdByGlobalId(result.receipt.applied[1].globalId!);
  const column = reader.entity(columnId); assert.equal(column?.type.toUpperCase(), 'IFCCOLUMN');
  const local = reader.entity(refId(column?.attributes[5])!);
  const placement = reader.entity(refId(local?.attributes[0])!);
  assert.equal(placement?.type.toUpperCase(), 'IFCGRIDPLACEMENT');
  const intersection = reader.entity(refId(placement?.attributes[0])!);
  assert.equal(intersection?.type.toUpperCase(), 'IFCVIRTUALGRIDINTERSECTION');
  const gridId = parsed.entities.getExpressIdByGlobalId(result.receipt.applied[0].globalId!);
  const grid = reader.entity(gridId)!;
  assert.deepEqual(intersection?.attributes[0], [(grid.attributes[7] as number[])[1], (grid.attributes[8] as number[])[1]]);
  const repeated = commitModelAuthoring(useViewerStore, preview, new Set([0, 1]), 'same review again');
  assert.ok(!repeated.ok, 'approval source revision cannot be replayed to duplicate grid products');
  assert.deepEqual(undoModelChanges(useViewerStore, result.receipt), { ok: true });
  assert.equal(view.getNewEntity(gridId), null); assert.equal(view.getNewEntity(columnId), null);
  useViewerStore.getState().redo(SAMPLE_MODEL);
  assert.ok(view.getNewEntity(gridId)); assert.ok(view.getNewEntity(columnId), 'one native Redo restores both actual bound identities');
});


test('#7304 both explicit selection and rich native sources expose exact grid-axis SI identity without axis GUIDs', async () => {
  const { made, view } = await nativeGrid();
  useViewerStore.setState({ selectedEntityIds: new Set([made.expressId]), selectedEntityId: made.expressId,
    selectedEntity: { modelId: SAMPLE_MODEL, expressId: made.expressId }, selectedEntities: [], selectedEntitiesSet: new Set() });
  const revision = view.getMutationRevision();
  const attached = captureSelectionGrounding(useViewerStore.getState()).elements[0];
  const snapshot = captureEvidence('selection');
  const row = JSON.parse(snapshot.payload).evidence.rows[0].data;
  const canonical = nativeGridEvidence(nativeReadTargets(useViewerStore.getState())(SAMPLE_MODEL), made.expressId);
  assert.ok(canonical?.expected); assert.equal(canonical.status, 'available');
  assert.equal(canonical.units, 'm'); assert.equal(canonical.axisCount, 4);
  assert.deepEqual(attached.nativeGrid, canonical); assert.deepEqual(row.nativeGrid, canonical);
  assert.deepEqual(canonical.expected.axes.map(axis => axis.expressId), [...made.build.uAxisIds, ...made.build.vAxisIds]);
  assert.ok(canonical.expected.axes.every(axis => !('GlobalId' in axis)), 'IfcGridAxis is non-root');
  assert.deepEqual(canonical.expected.frame.o, [0, 0, 0]);
  const proposal = parseModelAuthoringBatch(batch([{ op: 'column.createOnGrid', ref: 'existing-grid-column',
    storey: { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL },
    grid: { target: { globalId: attached.globalId, modelId: attached.modelId, ifcClass: attached.type, name: attached.name },
      expected: attached.nativeGrid!.expected, IntersectingAxes: [made.build.uAxisIds[1], made.build.vAxisIds[1]] },
    params: { Position: [6, 4, 0], Width: .4, Depth: .2, Height: 3, Name: 'Captured native crossing' } }]));
  const preview = previewModelAuthoring(useViewerStore.getState(), proposal);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
  assert.equal(view.getMutationRevision(), revision, 'both producer routes and preflight preserve the native live view');
});

test('#7304 named current grid placement cannot publish stale saved-frame axis coordinates', async () => {
  const { made, dataStore, view } = await nativeGrid();
  const reader = new AnchorEntityReader(dataStore, view);
  const placement = reader.entity(refId(reader.entity(made.expressId)!.attributes[5])!)!;
  const relativeId = refId(placement.attributes[1])!;
  const editor = useViewerStore.getState().storeEditors.get(SAMPLE_MODEL)!;
  const pointId = editor.addEntity('IfcCartesianPoint', [[2000, 3000, 0]]).expressId;
  editor.setAttribute(relativeId, 'Location', `#${pointId}`);
  const exported = await parseIfc(editedModelBytes(dataStore, view));
  assert.deepEqual(new AnchorEntityReader(exported, null).entity(pointId)?.attributes[0], [2000, 3000, 0], 'native STEP proves effective named placement');
  assert.equal(refId(new AnchorEntityReader(exported, null).entity(relativeId)?.attributes[0]), pointId);
  const evidence = nativeGridEvidence(nativeReadTargets(useViewerStore.getState())(SAMPLE_MODEL), made.expressId)!;
  if (evidence.expected) assert.deepEqual(evidence.expected.axes[0].a, [2, 2]);
  else assert.equal(evidence.status, 'unavailable', 'unknown current coordinates must be explicitly unavailable');
  useViewerStore.setState({ selectedEntityId: made.expressId, selectedEntityIds: new Set([made.expressId]), selectedEntity: { modelId: SAMPLE_MODEL, expressId: made.expressId } });
  assert.equal(captureSelectionGrounding(useViewerStore.getState()).elements[0].nativeGrid?.status, 'unavailable');
  assert.equal(JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data.nativeGrid.status, 'unavailable');
});

test('#7304 explicit model ownership preserves the other federated source and grid axis bounds refuse before native writes', async () => {
  const { dataStore } = await seedAuthoringSample();
  const second = await parseIfc(dataStore.source.materialize());
  const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  const a = { ...model, id: 'a', idOffset: 0, ifcDataStore: dataStore }, b = { ...model, id: 'b', idOffset: 1_000_000, ifcDataStore: second };
  const va = new MutablePropertyView(dataStore.properties, 'a'), vb = new MutablePropertyView(second.properties, 'b');
  useViewerStore.setState({ models: new Map([['a', a], ['b', b]]), activeModelId: 'a', mutationViews: new Map([['a', va], ['b', vb]]), storeEditors: new Map() });
  const operation = { op: 'grid.create', ref: 'federated-grid', storey: { globalId: GROUND_STOREY, modelId: 'b' }, params };
  assert.throws(() => parseModelAuthoringBatch(batch([{ ...operation, storey: { globalId: GROUND_STOREY } }])), /explicit loaded modelId/);
  const many = rectangularGridAxes({ UOffsets: Array.from({ length: 100 }, (_, i) => i), VOffsets: Array.from({ length: 100 }, (_, i) => i) });
  assert.doesNotThrow(() => parseModelAuthoringBatch(batch([{ ...operation, params: { ...params, ...many } }])));
  assert.throws(() => parseModelAuthoringBatch(batch([{ ...operation, params: { ...params, ...many } }, { ...operation, ref: 'over-bound' }])), /200/);
  const preview = previewModelAuthoring(useViewerStore.getState(), parseModelAuthoringBatch(batch([operation])));
  assert.equal(preview.rows[0].modelId, 'b'); assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'explicit federated grid'); assert.ok(result.ok);
  assert.equal(va.getNewEntities().length, 0); assert.equal(va.getMutationRevision(), 0);
  const exported = await parseIfc(editedModelBytes(second, vb));
  assert.ok(exported.entities.getExpressIdByGlobalId(result.receipt.applied[0].globalId) > 0);
  assert.equal(dataStore.entities.getExpressIdByGlobalId(result.receipt.applied[0].globalId), -1);
});

test('#7304 actual reviewed bound column exported mesh retains declared millimetre dimensions', { skip: !stairWasmAvailable && 'pnpm build:wasm:fetch' }, async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const operations = [
    { op: 'grid.create', ref: 'mesh-grid', storey: { modelId: SAMPLE_MODEL, globalId: GROUND_STOREY }, params: { ...params, ...rectangularGridAxes({ UOffsets: [0, 6000], VOffsets: [0, 4000], Overhang: 1000 }) } },
    { op: 'column.createOnGrid', ref: 'mesh-column', storey: { modelId: SAMPLE_MODEL, globalId: GROUND_STOREY }, grid: { ref: 'mesh-grid', IntersectingAxes: ['2', 'B'] }, params: { Position: [6000, 4000, 0], Width: 400, Depth: 200, Height: 3000 } },
  ];
  const proposal = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Actual native mesh', units: 'mm', frame: 'storey-local', operations }));
  const preview = previewModelAuthoring(useViewerStore.getState(), proposal); assert.ok(preview.rows.every(row => row.status === 'ready'));
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0, 1]), 'native geometry proof'); assert.ok(result.ok);
  const bytes = editedModelBytes(dataStore, view), parsed = await parseIfc(bytes);
  const id = parsed.entities.getExpressIdByGlobalId(result.receipt.applied[1].globalId);
  const meshes = await meshStairs(new TextDecoder().decode(bytes));
  assert.ok(meshes.has(id), 'the real Rust/WASM producer emits the reviewed grid-bound column');
  const bounds = stairMeshBounds(meshes.get(id)!);
  const size = bounds.max.map((value, i) => value - bounds.min[i]);
  for (const [i, expected] of [0.4, 0.2, 3].entries()) assert.ok(Math.abs(size[i] - expected) < 1e-4, `native axis ${i} size ${size[i]} vs ${expected}`);
});

test('#7304 reviewed grid strips and bound column ghosts use the native saved frame and no live allocation', async () => {
  const { view } = await seedAuthoringSample();
  const proposal = parseModelAuthoringBatch(batch([{ op: 'grid.create', ref: 'ghost-grid', storey: { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL }, params }]));
  const revision = view.getMutationRevision();
  const preview = previewModelAuthoring(useViewerStore.getState(), proposal);
  assert.equal(preview.rows[0].status, 'ready');
  assert.equal(preview.rows[0].previewUnavailable, false);
  const meshes = authoringGhosts(useViewerStore.getState(), preview);
  assert.ok(meshes.length > 0, 'saved source frame has a real native strip preview');
  assert.ok(meshes.every(mesh => mesh.positions.length > 0 && [...mesh.positions].every(Number.isFinite)));
  assert.equal(view.getMutationRevision(), revision, 'native draft ghost keeps live mutation revision untouched');
});

for (const change of ['axis-tag', 'axis-endpoint', 'source-replacement'] as const) test(`#7304 current native ${change} invalidates an approved grid crossing without further writes`, async () => {
  const { made, view, dataStore } = await nativeGrid();
  const target = nativeReadTargets(useViewerStore.getState())(SAMPLE_MODEL)!;
  const expected = nativeGridEvidence(target, made.expressId)!.expected!;
  const root = view.getNewEntity(made.expressId)!;
  const proposal = parseModelAuthoringBatch(batch([{ op: 'column.createOnGrid', ref: 'stale-grid-column',
    storey: { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL }, grid: { target: { globalId: root.attributes[0], modelId: SAMPLE_MODEL, ifcClass: 'IfcGrid', name: root.attributes[2] },
      expected, IntersectingAxes: [made.build.uAxisIds[1], made.build.vAxisIds[1]] }, params: { Position: [6, 4, 0], Width: .4, Depth: .2, Height: 3 } }]));
  const preview = previewModelAuthoring(useViewerStore.getState(), proposal); assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
  const beforeRevision = view.getMutationRevision();
  if (change === 'source-replacement') {
    const replacement = await parseIfc(dataStore.source.materialize());
    const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
    useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: replacement }]]) });
  } else if (change === 'axis-tag') useViewerStore.getState().storeEditors.get(SAMPLE_MODEL)!.setAttribute(made.build.uAxisIds[1], 'AxisTag', 'Current renamed axis');
  else {
    const read = new AnchorEntityReader(dataStore, view), axis = read.entity(made.build.uAxisIds[1])!;
    const curve = read.entity(refId(axis.attributes[1])!)!;
    const points = curve.attributes[0] as unknown[];
    useViewerStore.getState().storeEditors.get(SAMPLE_MODEL)!.setPositionalAttribute(refId(points[0])!, 0, [8000, -1000]);
  }
  const revision = view.getMutationRevision();
  if (change !== 'source-replacement') assert.ok(revision > beforeRevision, 'the public live native edit really advanced source provenance');
  if (change === 'axis-tag') {
    const reparsed = await parseIfc(editedModelBytes(dataStore, view));
    const actual = new AnchorEntityReader(reparsed, null).entity(made.build.uAxisIds[1]);
    assert.equal(actual?.attributes[0], 'Current renamed axis', 'native STEP exporter proves the current named AxisTag edit');
  }
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'stale current native grid');
  assert.ok(!result.ok); assert.equal(result.reason, 'stale');
  assert.equal(view.getMutationRevision(), revision, 'refusal adds no native entities or edits');
  if (change !== 'source-replacement') assert.equal(previewModelAuthoring(useViewerStore.getState(), proposal).rows[0].status, 'conflict', 'copied old expected native data cannot silently bind to changed axes');
});


for (const mode of ['attached', 'rich-source'] as const) test(`#7304 real provider request ${mode} contains native grid evidence usable by reviewed native creation`, async () => {
  const { made, dataStore, view } = await nativeGrid();
  useViewerStore.setState({ selectedEntityIds: new Set([made.expressId]), selectedEntityId: made.expressId,
    selectedEntity: { modelId: SAMPLE_MODEL, expressId: made.expressId }, selectedEntities: [], selectedEntitiesSet: new Set() });
  const grounding = captureSelectionGrounding(useViewerStore.getState());
  const snapshot = captureEvidence(mode === 'attached' ? 'loadReport' : 'selection');
  replaceEvidence(snapshot);
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const wire = JSON.parse(String(init?.body));
    const system = typeof wire.system === 'string' ? wire.system : wire.system.map((part: { text: string }) => part.text).join('\n');
    assert.ok(system.includes('column.createOnGrid'), 'actual sent provider contract admits native grid binding');
    const requestText = [system, ...wire.messages.map((message: { content: string | Array<{ text?: string }> }) => typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('\n'))].join('\n');
    assert.ok(requestText.includes(mode === 'attached' ? selectionGroundingText(grounding) : snapshot.payload), 'the complete real request transports the native snapshot');
    const row = mode === 'attached' ? grounding.elements[0] : JSON.parse(snapshot.payload).evidence.rows[0].data;
    assert.equal(row.nativeGrid.status, 'available'); assert.equal(row.nativeGrid.axisCount, 4);
    const answer = batch([{ op: 'column.createOnGrid', ref: 'wire-column', storey: { globalId: GROUND_STOREY, modelId: row.modelId },
      grid: { target: { globalId: row.globalId, modelId: row.modelId, ifcClass: row.type, name: row.name }, expected: row.nativeGrid.expected,
        IntersectingAxes: [row.nativeGrid.expected.axes[1].expressId, row.nativeGrid.expected.axes[3].expressId] },
      params: { Position: [6, 4, 0], Width: .4, Depth: .2, Height: 3, Name: 'Actual transported grid column' } }]);
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\n`);
  };
  const attachments = mode === 'attached' ? { selection: selectionGroundingText(grounding), selectionSnapshot: grounding } : {};
  assert.equal(await sendAssistant('Create the explicitly sized column on this grid intersection', 'openai/gpt-free', '/api/chat', attachments), true, useAssistant.getState().error ?? '');
  assert.equal(calls, 1);
  const answer = useAssistant.getState().messages.at(-1)?.content; assert.ok(answer);
  const preview = previewModelAuthoring(useViewerStore.getState(), parseModelAuthoringBatch(answer));
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'actual transported grid');
  assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const reader = new AnchorEntityReader(parsed, null), column = reader.entity(parsed.entities.getExpressIdByGlobalId(result.receipt.applied[0].globalId))!;
  const local = reader.entity(refId(column.attributes[5])!)!;
  assert.equal(reader.entity(refId(local.attributes[0])!)?.type.toUpperCase(), 'IFCGRIDPLACEMENT', 'transported native axis state produces real persisted grid binding');
});
