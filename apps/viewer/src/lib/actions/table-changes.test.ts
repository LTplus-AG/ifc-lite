/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// P15 (#6912): table rows become reviewed model.changes against a real SketchUp-authored model.

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView, type CsvRow } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';
import { useViewerStore } from '@/store';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { installSampleModel, parseIfcBytes, SAMPLE_WALLS } from '@/test/sample-corrections-fixture';
import { parseModelChangeBatch } from '@ifc-lite/ai/artifacts';
import { previewModelChanges } from './model-change-preview';
import { commitModelChanges } from './model-change-commit';
import { tableRowsOf, tableToModelChanges } from './table-changes';
import type { TableMapping } from './table-mapping';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));

const W = SAMPLE_WALLS;
const mapping = (overrides: Partial<TableMapping> = {}): TableMapping => ({
  version: 1, kind: 'table.mapping', title: 'Wall schedule', identity: { column: 'GlobalId', key: 'GlobalId' },
  columns: [
    { column: 'Fire', target: 'property', pset: 'Pset_WallCommon', name: 'FireRating', valueType: 'text' },
    { column: 'Width (m)', target: 'quantity', qset: 'Qto_WallBaseQuantities', name: 'Width', unit: 'm' },
    { column: 'Mark', target: 'attribute', name: 'Tag' },
  ], ...overrides,
});

const rows: CsvRow[] = [
  { GlobalId: W.rightFront, Fire: 'EI60', 'Width (m)': '0.25', Mark: '' },
  { GlobalId: W.rightBack, Fire: 'EI90', 'Width (m)': '12,5', Mark: 'W-02' },
  { GlobalId: '', Fire: 'EI30', 'Width (m)': '', Mark: '' },
  { GlobalId: '2Missing0000000000000x', Fire: 'EI30', 'Width (m)': '', Mark: '' },
  { GlobalId: W.left, Fire: 'EI30', 'Width (m)': '', Mark: '' },
  { GlobalId: W.left, Fire: 'EI60', 'Width (m)': '', Mark: '' },
];

test('CSV rows convert to changes with the effective model values as expected values, never guessing a key', async () => {
  const { data, view } = await installSampleModel();
  const front = data.entities.getExpressIdByGlobalId(W.rightFront);
  // A pending edit is part of the effective model the table is compared against.
  useViewerStore.getState().setProperty('sample', front, 'Pset_WallCommon', 'FireRating', 'EI30', PropertyValueType.Label);
  const widthBefore = view.getQuantitiesForEntity(front).find((s) => s.name === 'Qto_WallBaseQuantities')!
    .quantities.find((q) => q.name === 'Width')!.value;

  const conversion = tableToModelChanges(useViewerStore.getState(), { modelId: 'sample', rows, mapping: mapping() });
  const changes = conversion.batches.flatMap((batch) => batch.changes);
  assert.deepEqual(changes.map((c) => [c.target.globalId, c.op, 'expected' in c ? c.expected : undefined, 'value' in c ? c.value : undefined]), [
    [W.rightFront, 'property.set', 'EI30', 'EI60'],
    [W.rightFront, 'quantity.set', widthBefore, 250],
    [W.rightBack, 'property.set', null, 'EI90'],
    [W.rightBack, 'attribute.set', '454425.1027891.979946.932083.920031', 'W-02'],
  ]);
  assert.equal(widthBefore, 200.0000000000007, 'the SketchUp file stores the wall width in millimetres');
  assert.deepEqual(conversion.issues.map((issue) => [issue.kind, issue.row]), [
    ['invalid-value', 2], ['missing-key', 3], ['unmatched-key', 4], ['duplicate-key', 5], ['duplicate-key', 6]]);
  assert.equal(conversion.batches.length, 1);
  assert.deepEqual(parseModelChangeBatch(JSON.stringify(conversion.batches[0])), conversion.batches[0], 'the batch satisfies the strict contract');
});

test('Name keys refuse the wall whose type carries the same Name; Tag keys resolve it', async () => {
  await installSampleModel();
  const byName = tableToModelChanges(useViewerStore.getState(), { modelId: 'sample', rows: [{ Key: 'house - outer wall - house left', Fire: 'EI60' }],
    mapping: mapping({ identity: { column: 'Key', key: 'Name' }, columns: [{ column: 'Fire', target: 'property', pset: 'Pset_WallCommon', name: 'FireRating', valueType: 'text' }] }) });
  assert.deepEqual(byName.issues.map((issue) => [issue.kind, issue.detail]), [['ambiguous-key', '2']]);
  assert.equal(byName.total, 0);

  const byTag = tableToModelChanges(useViewerStore.getState(), { modelId: 'sample', rows: [{ Key: '454425.1027891.979946.932083.920032', Fire: 'EI60' }],
    mapping: mapping({ identity: { column: 'Key', key: 'Tag' }, columns: [{ column: 'Fire', target: 'property', pset: 'Pset_WallCommon', name: 'FireRating', valueType: 'text' }] }) });
  assert.deepEqual(byTag.batches[0].changes.map((c) => c.target.globalId), [W.left]);
});

test('a unit that does not fit the target and an existing value are reported, not written', async () => {
  await installSampleModel();
  const conversion = tableToModelChanges(useViewerStore.getState(), { modelId: 'sample',
    rows: [{ GlobalId: W.rightFront, Area: '2', Missing: '3' }],
    mapping: mapping({ columns: [
      { column: 'Area', target: 'quantity', qset: 'Qto_WallBaseQuantities', name: 'Width', unit: 'm2' },
      { column: 'Missing', target: 'quantity', qset: 'Qto_WallBaseQuantities', name: 'NoSuchQuantity' },
    ] }) });
  assert.deepEqual(conversion.issues.map((issue) => issue.kind), ['unit-mismatch', 'missing-quantity']);
  assert.equal(conversion.total, 0);
});

test('a value changed after the table was read is a conflict in review and is not overwritten', async () => {
  const { data, view } = await installSampleModel();
  const conversion = tableToModelChanges(useViewerStore.getState(), { modelId: 'sample', rows: rows.slice(0, 2), mapping: mapping() });
  const back = data.entities.getExpressIdByGlobalId(W.rightBack);
  useViewerStore.getState().setProperty('sample', back, 'Pset_WallCommon', 'FireRating', 'REI120', PropertyValueType.Label);

  const preview = previewModelChanges(useViewerStore.getState(), conversion.batches[0]);
  assert.deepEqual(preview.rows.map((row) => row.status), ['ready', 'ready', 'conflict', 'ready']);
  const outcome = commitModelChanges(useViewerStore, preview, new Set(preview.rows.map((row) => row.index)), 'csv:test');
  assert.ok(outcome.ok);
  assert.equal(outcome.receipt.applied.length, 3);
  assert.deepEqual(outcome.receipt.skipped, [{ index: 2, status: 'conflict' }]);
  assert.equal(view.getPropertyValue(back, 'Pset_WallCommon', 'FireRating'), 'REI120', 'the newer value is kept');

  // One undo step, and the IFC export carries the reviewed values in the model's own units.
  const exported = await parseIfcBytes(editedModelBytes(data, view));
  const reread = new MutablePropertyView(exported.properties, 'reparsed');
  configureMutationView(reread, exported);
  const front = exported.entities.getExpressIdByGlobalId(W.rightFront);
  const width = reread.getQuantitiesForEntity(front).find((s) => s.name === 'Qto_WallBaseQuantities')?.quantities.find((q) => q.name === 'Width');
  assert.equal(width?.value, 250, '0.25 m was written as 250 mm');
  assert.equal(reread.getPropertyValue(front, 'Pset_WallCommon', 'FireRating'), 'EI60');
  assert.equal(exported.entities.getExpressIdByGlobalId(W.rightBack) > 0, true);

  useViewerStore.getState().undo('sample');
  assert.equal(view.getPropertyValue(data.entities.getExpressIdByGlobalId(W.rightFront), 'Pset_WallCommon', 'FireRating'), null,
    'one Ctrl+Z reverts the applied table rows');
  assert.equal(view.getPropertyValue(back, 'Pset_WallCommon', 'FireRating'), 'REI120');
});

// #6912: the Data Connector builds its mapping from manual rows; a column mapped twice onto one value
// or an empty set name is refused as a mapping, never thrown from the click handler or written as `pset: ''`.
test('a mapping with two columns writing one value or an empty set name is refused, not thrown', async () => {
  await installSampleModel();
  const twice = mapping({ columns: [
    { column: 'Fire', target: 'property', pset: 'Pset_WallCommon', name: 'FireRating', valueType: 'text' },
    { column: 'Mark', target: 'property', pset: 'Pset_WallCommon', name: 'FireRating', valueType: 'text' },
  ] });
  const conversion = tableToModelChanges(useViewerStore.getState(), { modelId: 'sample', rows: rows.slice(0, 2), mapping: twice });
  assert.equal(conversion.refusal, 'invalid-mapping');
  assert.deepEqual(conversion.batches, []);
  const unnamed = mapping({ columns: [{ column: 'Fire', target: 'property', pset: ' ', name: 'FireRating', valueType: 'text' }] });
  assert.equal(tableToModelChanges(useViewerStore.getState(), { modelId: 'sample', rows: rows.slice(0, 2), mapping: unnamed }).refusal, 'invalid-mapping');
  // A mapping row with a target but no source column, or no columns at all, is refused too, never "nothing to change".
  const sourceless = mapping({ columns: [{ column: '', target: 'property', pset: 'Pset_WallCommon', name: 'FireRating', valueType: 'text' }] });
  assert.equal(tableToModelChanges(useViewerStore.getState(), { modelId: 'sample', rows: rows.slice(0, 2), mapping: sourceless }).refusal, 'invalid-mapping');
  assert.equal(tableToModelChanges(useViewerStore.getState(), { modelId: 'sample', rows: rows.slice(0, 2), mapping: mapping({ columns: [] }) }).refusal, 'invalid-mapping');
});

// #6912: the Data Connector reads rows during render; a CSV the parser rejects is no rows, not a crashed dialog.
test('rows of a CSV the parser rejects are none, never a throw', () => {
  assert.deepEqual(tableRowsOf({ parse: () => { throw new Error('Unterminated quote'); } }, '"a,b'), []);
  assert.deepEqual(tableRowsOf(null, 'a,b'), []);
  assert.deepEqual(tableRowsOf({ parse: () => [{ a: '1' }] }, 'a\n1'), [{ a: '1' }]);
});
