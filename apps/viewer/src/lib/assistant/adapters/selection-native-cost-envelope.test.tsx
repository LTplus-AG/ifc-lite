/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { useViewerStore } from '@/store';
import { seedAuthoringSample, SAMPLE_MODEL, parseIfc } from '@/test/authoring-sample-fixture';
import { captureEvidence } from '@/lib/assistant/evidence';
import { nativeCostTransportEvidence } from '@/lib/actions/cost-graph-evidence';
import { nativeReadTargets } from '@/lib/actions/model-authoring-read-target';
import { evidenceJson, TEXT_LIMIT } from '@/lib/assistant/projection';
import { extractClassificationsOnDemand } from '@ifc-lite/parser';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { cleanup } from '@/test/render';

// #7360 / #7361: actual native ordinary-row reservation regressions.
// All rows below come from the production selection adapter reading the committed
// SketchUp IFC and its real native/property overlay; there is no adapter mock.
const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
type Pin = { status: string; recordCount: number | null; expectedJsonParts: string[] | null };
type Row = { citation: string; data: Record<string, unknown> & { nativeCost: Pin } };
type Payload = { serializedLength: number; evidence: { summary: Record<string, unknown>; rows: Row[] }; models: unknown[];
  totalRows: number; includedRows: number; sampled: boolean; projectionTruncated: boolean };
function capture(): Payload { const text = captureEvidence('selection').payload; return { ...JSON.parse(text) as Payload, serializedLength: text.length }; }
function ordinary(rows: Row[]) {
  return rows.map(row => {
    const { nativeCost: _cost, ...data } = row.data;
    return { ...row, data };
  });
}
function used(payload: Payload): number {
  return evidenceJson(payload.evidence.summary).text.length + JSON.stringify(payload.models).length + 2000
    + payload.evidence.rows.reduce((sum, row) => sum + evidenceJson(row).text.length + 2, 0);
}
async function fixture(reverse = false) {
  const result = await seedAuthoringSample();
  const state = useViewerStore.getState();
  const model = state.models.get(SAMPLE_MODEL); assert.ok(model);
  const maximum = Math.max(...result.dataStore.entityIndex.byId.keys());
  state.models.set(SAMPLE_MODEL, { ...model, maxExpressId: maximum });
  result.view.setExpressIdWatermark(maximum + 1000);
  const ids = reverse ? [353, 291] : [291, 353];
  useViewerStore.setState({ selectedEntities: ids.map(expressId => ({ modelId: SAMPLE_MODEL, expressId })),
    selectedEntitiesSet: new Set(), selectedEntityIds: new Set(ids), selectedEntity: null, selectedEntityId: null });
  const system = result.view.createEntity('IfcClassification', ['SketchUp acceptance', '2026', null, 'Envelope classification', null, null, null]);
  for (const [index, id] of ids.entries()) {
    const reference = result.view.createEntity('IfcClassificationReference', [null, `W-${id}`, `Native classified wall ${id}`, `#${system.expressId}`, null, null]);
    result.view.createEntity('IfcRelAssociatesClassification', [`${index + 1}`.padStart(22, '0'), null, null, null, [`#${id}`], `#${reference.expressId}`]);
  }
  // A genuine unselected schedule changes Cost authority only. Its oversized
  // native Name makes the canonical complete graph unavailable, rather than
  // replacing adapter output with an artificial 'ordinary-only' row.
  const schedule = result.view.createEntity('IfcCostSchedule', ['0000000000000000000099', null, 'x'.repeat(80000), null, null, 'Envelope', '.BUDGET.', null, null, null]);
  const setValues = (length: number) => {
    for (const id of ids) for (let set = 0; set < 3; set++) for (let property = 0; property < 32; property++)
      result.view.setProperty(id, `Pset_Envelope_${set}`, `Native_${property}`, 'p'.repeat(length));
  };
  return { ...result, ids, schedule: schedule.expressId, setValues };
}
function assertPins(payload: Payload) {
  for (const row of payload.evidence.rows) {
    const target = nativeReadTargets(useViewerStore.getState())(String(row.data.modelId));
    const native = nativeCostTransportEvidence(target, Number(row.data.expressId));
    assert.equal(native.status, 'available', 'the real producer must have a complete graph');
    if (row.data.nativeCost.status === 'available') assert.deepEqual(row.data.nativeCost, native);
    else {
      assert.equal(row.data.nativeCost.status, 'unavailable-transport-budget');
      assert.equal(row.data.nativeCost.recordCount, null);
      assert.equal(row.data.nativeCost.expectedJsonParts, null);
    }
  }
}
for (const reverse of [false, true]) test(`#7360 real native Cost cannot displace later ordinary rows (reverse=${reverse})`, async () => {
  const f = await fixture(reverse);
  // Finite binary calibration over actual production captures, not guessed
  // synthetic row widths. Values remain within the existing 240-char bound.
  let low = 1, high = 240, baseline: Payload | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2); f.setValues(middle);
    const candidate = capture();
    if (candidate.includedRows === 2 && used(candidate) <= TEXT_LIMIT - 600) {
      baseline = candidate; low = middle + 1;
    } else high = middle - 1;
  }
  assert.ok(baseline, 'both native ordinary rows must fit');
  f.setValues(high); baseline = capture();
  assert.equal(baseline.includedRows, 2); assert.equal(baseline.totalRows, 2);
  assert.ok(used(baseline) > TEXT_LIMIT - 4000, 'fixture must exercise the real remaining envelope');
  assert.ok(baseline.evidence.rows.every(row => row.data.nativeCost.status !== 'available' && row.data.nativeCost.recordCount === null && row.data.nativeCost.expectedJsonParts === null));
  f.view.setAttribute(f.schedule, 'Name', '"\\'.repeat(120));
  const target = nativeReadTargets(useViewerStore.getState())(SAMPLE_MODEL);
  const pin = nativeCostTransportEvidence(target, f.ids[0]); assert.equal(pin.status, 'available');
  assert.ok(JSON.stringify(JSON.stringify(pin)).length < 12000, 'pin fits standalone optional allowance');
  assert.ok(JSON.stringify(pin).length > TEXT_LIMIT - baseline.serializedLength, 'pin exceeds actual serialized remaining envelope');
  assert.ok(baseline.serializedLength < TEXT_LIMIT);
  const actual = capture();
  assert.equal(actual.includedRows, baseline.includedRows); assert.equal(actual.totalRows, 2);
  assert.deepEqual(ordinary(actual.evidence.rows), ordinary(baseline.evidence.rows));
  assertPins(actual);
  assert.ok(actual.evidence.rows.some(row => row.data.nativeCost.status === 'unavailable-transport-budget'));
});

test('#7360 real ordinary overflow retains its ordered prefix and native total', async () => {
  const f = await fixture(); f.setValues(240);
  const baseline = capture();
  assert.ok(baseline.includedRows > 0 && baseline.includedRows < 2, 'ordinary native rows alone must overflow');
  assert.equal(baseline.totalRows, 2); assert.equal(baseline.sampled, true); assert.equal(baseline.projectionTruncated, true);
  f.view.setAttribute(f.schedule, 'Name', 'Small native schedule');
  const actual = capture();
  assert.equal(actual.totalRows, 2); assert.equal(actual.includedRows, baseline.includedRows);
  assert.equal(actual.sampled, true); assert.equal(actual.projectionTruncated, true);
  assert.deepEqual(ordinary(actual.evidence.rows), ordinary(baseline.evidence.rows));
  assertPins(actual);
});

async function verifyNativeClassifications(f: Awaited<ReturnType<typeof fixture>>, payload: Payload) {
  const exported = await parseIfc(editedModelBytes(f.dataStore, f.view));
  for (const row of payload.evidence.rows) {
    const id = Number(row.data.expressId);
    const native = extractClassificationsOnDemand(exported, id);
    assert.ok(native.some(info => info.name === `Native classified wall ${id}`));
    const projected = row.data.classifications as Array<{ Name: string }>;
    assert.ok(projected.some(info => info.Name === `Native classified wall ${id}`));
  }
}

test('#7360 real native small complete Cost pin remains admitted without altering ordinary facts', async () => {
  const f = await fixture(); f.setValues(1);
  const baseline = capture(); assert.equal(baseline.includedRows, 2);
  f.view.setAttribute(f.schedule, 'Name', 'Small native schedule');
  const actual = capture(); assert.equal(actual.includedRows, 2);
  assert.deepEqual(ordinary(actual.evidence.rows), ordinary(baseline.evidence.rows));
  assert.ok(actual.evidence.rows.some(row => row.data.nativeCost.status === 'available'));
  assertPins(actual); await verifyNativeClassifications(f, actual);
});

test('#7360 competing real escaped Cost pins refuse a whole graph and preserve all ordinary facts', async () => {
  const f = await fixture(); f.setValues(1);
  const baseline = capture(); assert.equal(baseline.includedRows, 2);
  let measured: number[] = [];
  // Grow a finite actual graph with schema-valid <=255-character IfcLabels.
  // No individual name or graph is fabricated to bypass canonical admission.
  const escapedName = String.fromCharCode(34, 92).repeat(120);
  assert.ok(escapedName.length <= 255);
  f.view.setAttribute(f.schedule, 'Name', escapedName);
  for (let schedules = 1; schedules <= 4; schedules++) {
    const currentTarget = nativeReadTargets(useViewerStore.getState())(SAMPLE_MODEL);
    const pins = f.ids.map(id => nativeCostTransportEvidence(currentTarget, id));
    assert.ok(pins.every(pin => pin.status === 'available'));
    measured = pins.map(pin => JSON.stringify(JSON.stringify(pin)).length);
    if (measured.every(length => length < 12000) && measured.reduce((sum, length) => sum + length, 0) > 12000) break;
    if (schedules < 4) f.view.createEntity('IfcCostSchedule', [String(100 + schedules).padStart(22, '0'), null,
      escapedName, null, null, `Competing ${schedules}`, '.BUDGET.', null, null, null]);
  }
  assert.ok(measured.every(length => length < 12000));
  assert.ok(measured.reduce((sum, length) => sum + length, 0) > 12000);
  const actual = capture(); assert.equal(actual.includedRows, 2);
  assert.deepEqual(ordinary(actual.evidence.rows), ordinary(baseline.evidence.rows));
  assert.equal(actual.evidence.rows.filter(row => row.data.nativeCost.status === 'available').length, 1);
  assert.equal(actual.evidence.rows.filter(row => row.data.nativeCost.status === 'unavailable-transport-budget').length, 1);
  assertPins(actual); await verifyNativeClassifications(f, actual);
});
