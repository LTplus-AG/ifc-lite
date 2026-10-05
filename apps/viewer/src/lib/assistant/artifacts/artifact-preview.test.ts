/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Artifact reviews against the committed samples (viewer AI P13, #6914):
 * the population, units and denominators a review states equal what the
 * native engine returns when called directly, and what the IFC file says.
 * Oracles from `building-architecture.ifc`: wall Qto NetSideArea 6.346 +
 * 8.928 + 21.154 + 6.863 = 43.291 m²; wall Length 1800 + 4200 + 6000 + 3800
 * = 15800 mm; slab Qto NetArea 25.750 + 22.401 + 31.212 = 79.363 m².
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import { aggregate, ELEMENT_COLUMNS } from '@ifc-lite/charts';
import { evaluateFilterGroupsFederated } from '@ifc-lite/rules';
import { QuantityType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { buildElementsDataset } from '@/lib/charts/datasets/elements';
import { ARCH, WALL, seedArtifactModels } from '@/test/artifact-models-fixture';
import { isPreviewCurrent, previewArtifact } from './artifact-preview';
import { modelSchemaIndex } from './model-schema';
import { parseArtifactProposal, type ArtifactKind } from './proposal-kinds';

before(async () => { await seedArtifactModels({ federated: true }); });
afterEach(() => { useViewerStore.setState({ mutationVersion: 0 }); });
const preview = (value: { kind: ArtifactKind } & Record<string, unknown>) =>
  previewArtifact(parseArtifactProposal(JSON.stringify({ version: 1, title: 'T', ...value }), value.kind), useViewerStore.getState());
const walls = { combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] };
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-3, `${actual} ≈ ${expected}`);

test('a filter review states the federated population the shared evaluator returns, per model', async () => {
  const result = await preview({ kind: 'filter.proposal', name: 'Walls', groups: [walls] });
  const direct = await evaluateFilterGroupsFederated(evaluatorModelsFromState(useViewerStore.getState()),
    result.artifact.kind === 'filter.proposal' ? result.artifact.groups : [], { limit: Number.POSITIVE_INFINITY });
  assert.equal(result.matched, direct.length);
  assert.deepEqual(result.population.map((m) => [m.modelId, m.count]), [[ARCH, 4], [WALL, 1]]);
  assert.deepEqual(result.samples.map((row) => row.name).sort(),
    ['Wall', 'house - outer wall - house left', 'house - outer wall - house right back', 'house - outer wall - house right front', 'plumbing wall']);
});

test('an empty filter is reported as zero per model, not as a failure', async () => {
  const result = await preview({ kind: 'filter.proposal', name: 'Doors', groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcDoor'] }] }] });
  assert.equal(result.matched, 0);
  assert.deepEqual(result.population.map((m) => m.count), [0, 0]);
});

test('a list review sums in the display unit and states how many rows carry the value', async () => {
  const result = await preview({ kind: 'list.proposal', list: { name: 'Areas', entityTypes: ['IfcWall', 'IfcSlab'], columns: [
    { id: 'name', source: 'attribute', propertyName: 'Name' },
    { id: 'area', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetSideArea' },
    { id: 'length', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'Length' },
    { id: 'rating', source: 'property', psetName: 'Pset_SlabCommon', propertyName: 'FireRating' }] } });
  // 4 walls + 3 slabs in the architecture model, 1 wall in hello-wall.
  assert.deepEqual(result.population.map((m) => [m.modelId, m.count]), [[ARCH, 7], [WALL, 1]]);
  const [area, length] = result.measures;
  assert.equal(area.unit, 'm²');
  close(area.total, 43.2914);
  assert.deepEqual([area.measured, area.rows], [4, 8], 'slabs and the hello-wall wall carry no wall quantity');
  assert.equal(length.unit, 'mm', 'the declared length unit of the contributing model');
  close(length.total, 15800);
  assert.equal(result.measures.length, 2, 'a text property has nothing to sum');
  const floor = result.samples.find((row) => row.name === 'floor');
  assert.equal(floor?.values[3], 'REI30', 'the occurrence value wins over the slab type\'s REI60');
});

test('a chart review reports Charts aggregate totals and the measured denominator', async () => {
  const result = await preview({ kind: 'chart.proposal', chart: { type: 'bar', dimension: 'IfcType', measure: { agg: 'sum' },
    measureField: { kind: 'quantity', qsetName: 'Qto_SlabBaseQuantities', quantityName: 'NetArea' } } });
  assert.ok(result.artifact.kind === 'chart.proposal');
  const spec = result.artifact.spec;
  const direct = aggregate(spec, buildElementsDataset({ kind: 'all' }, spec.measureField ? [spec.measureField] : [], useViewerStore.getState()));
  const [measure] = result.measures;
  close(measure.total, 79.3628);
  close(measure.total, direct.total);
  assert.equal(measure.unit, 'm²');
  assert.deepEqual([measure.measured, measure.rows], [3, 20], 'three slabs carry NetArea among twenty elements');
  assert.equal(result.buckets.find((b) => b.label === 'IfcSlab')?.count, 3);
  assert.deepEqual(result.population.map((m) => [m.modelId, m.count]), [[ARCH, 14], [WALL, 6]]);
  assert.equal(spec.dimension, ELEMENT_COLUMNS.ifcType);
});

test('a chart row without a dimension value is reported once, as uncharted, never again as unmeasured (#6914 review)', async () => {
  // Only the `floor` slab carries Pset_SlabCommon.FireRating (REI30); the other 19 elements are not charted.
  const result = await preview({ kind: 'chart.proposal', chart: { type: 'bar', elementField: { kind: 'property', psetName: 'Pset_SlabCommon', propertyName: 'FireRating' },
    measure: { agg: 'sum' }, measureField: { kind: 'quantity', qsetName: 'Qto_SlabBaseQuantities', quantityName: 'NetArea' } } });
  assert.equal(result.matched, 20);
  assert.equal(result.unassigned, 19);
  const [measure] = result.measures;
  assert.deepEqual([measure.measured, measure.rows], [1, 1], 'the sum covers the charted rows only');
  close(measure.total, 25.75);
  assert.equal(measure.rows + (result.unassigned ?? 0), result.matched, 'every row is either charted or reported uncharted, never both');
});

test('a chart source filter narrows the population before aggregation', async () => {
  const result = await preview({ kind: 'chart.proposal', chart: { type: 'pie', dimension: 'Model', measure: { agg: 'count' }, filter: { groups: [walls] } } });
  assert.equal(result.matched, 5);
  assert.deepEqual(result.buckets.map((b) => [b.label, b.count]).sort(), [['building-architecture.ifc', 4], ['hello-wall.ifc', 1]]);
});

test('a lens review counts first-match colouring, and the uncoloured remainder', async () => {
  const external = { combinator: 'AND', rules: [{ kind: 'property', setName: 'Pset_WallCommon', propertyName: 'IsExternal', op: 'eq', value: true }] };
  const result = await preview({ kind: 'lens.proposal', lens: { name: 'Walls', rules: [
    { name: 'External walls', groups: [external], action: 'colorize', color: '#E53935' },
    { name: 'Other walls', groups: [walls], action: 'transparent', color: '#1E88E5' }] } });
  const externalDirect = await evaluateFilterGroupsFederated(evaluatorModelsFromState(useViewerStore.getState()),
    result.artifact.kind === 'lens.proposal' ? result.artifact.lens.rules[0].groups : [], { limit: Number.POSITIVE_INFINITY });
  assert.equal(result.buckets[0].count, externalDirect.length);
  assert.equal(result.buckets[0].count + result.buckets[1].count, 5, 'every wall is coloured once: the first matching rule wins');
  assert.equal(result.matched, 5);
  assert.ok((result.unassigned ?? 0) > 0, 'non-wall entities stay uncoloured');
});

test('an auto-colour lens by material counts each element once, though a layered wall joins several material buckets (#6914 review)', async () => {
  const result = await preview({ kind: 'lens.proposal', lens: { name: 'Materials', autoColor: { source: 'material' } } });
  const memberships = result.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  assert.ok(memberships > result.matched, `hello-wall's layered wall is in more than one bucket (${memberships} memberships)`);
  assert.equal(result.population.reduce((sum, model) => sum + model.count, 0), result.matched);
  // hello-wall.ifc has six elements (the chart review counts them), so it can colour at most six.
  assert.ok((result.population.find((model) => model.modelId === WALL)?.count ?? 0) <= 6);
});

test('"this model" is a native model rule: names resolve to the durable fingerprint the Filter editor uses', async () => {
  const onlyWall = { combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }, { kind: 'model', op: 'in', values: ['hello-wall.ifc'] }] };
  const result = await preview({ kind: 'filter.proposal', name: 'Walls in hello-wall', groups: [onlyWall] });
  assert.deepEqual(result.population.map((m) => [m.modelId, m.count]), [[ARCH, 0], [WALL, 1]]);
  const saved = result.artifact.kind === 'filter.proposal' ? result.artifact.groups[0].rules[1] : null;
  assert.deepEqual(saved, { kind: 'model', op: 'in', values: [`fixture:${WALL}`] }, 'saved filters survive reload because they hold the fingerprint, not the name');
  const others = await preview({ kind: 'list.proposal', list: { name: 'L', entityTypes: ['IfcWall'], columns: [{ id: 'n', source: 'attribute', propertyName: 'Name' }],
    groups: [{ combinator: 'AND', rules: [{ kind: 'model', op: 'notIn', values: ['hello-wall.ifc'] }] }] } });
  assert.deepEqual(others.population.map((m) => [m.modelId, m.count]), [[ARCH, 4], [WALL, 0]]);
});

test('a model name that is not loaded is refused with the loaded names, never matched against nothing', async () => {
  await assert.rejects(preview({ kind: 'filter.proposal', name: 'N', groups: [{ combinator: 'AND', rules: [{ kind: 'model', op: 'notIn', values: ['Hello-Wall.ifc'] }] }] }),
    /"Hello-Wall\.ifc" is not a loaded model; loaded: building-architecture\.ifc, hello-wall\.ifc/);
});

test('a property only the type carries is inherited by its occurrences, in the index and in the filter', async () => {
  // building-architecture.ifc: the slab type's Pset_SlabCommon holds SurfaceSpreadOfFlame; the `floor` occurrence's own set does not.
  const field = (await modelSchemaIndex(useViewerStore.getState())).fields.get(`property:${JSON.stringify(['Pset_SlabCommon', 'SurfaceSpreadOfFlame'])}`);
  assert.deepEqual([...(field?.byModel ?? [])], [[ARCH, 1]]);
  const result = await preview({ kind: 'filter.proposal', name: 'Rated', groups: [{ combinator: 'AND', rules: [
    { kind: 'property', setName: 'Pset_SlabCommon', propertyName: 'SurfaceSpreadOfFlame', op: 'eq', value: 'A2 s1 d0' }] }] });
  assert.deepEqual(result.samples.map((row) => [row.ifcClass, row.name]), [['IfcSlab', 'floor']]);
});

test('a review belongs to one model revision', async () => {
  const result = await preview({ kind: 'filter.proposal', name: 'Walls', groups: [walls] });
  assert.equal(isPreviewCurrent(result, useViewerStore.getState()), true);
  useViewerStore.setState({ mutationVersion: 1 });
  assert.equal(isPreviewCurrent(result, useViewerStore.getState()), false, 'an edit after the run makes its numbers stale');
});

test('a numeric threshold reads the unsaved edit the list and chart read, not the file as loaded (#6914 review)', async () => {
  const state = useViewerStore.getState();
  const store = state.models.get(ARCH)?.ifcDataStore;
  assert.ok(store);
  const view = new MutablePropertyView(null, ARCH);
  configureMutationView(view, store);
  const netSideArea = (op: string, value: number) => ({ combinator: 'AND', rules: [{ kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'NetSideArea', op, value }] });
  const before = await preview({ kind: 'filter.proposal', name: 'Large', groups: [netSideArea('gt', 10)] });
  assert.deepEqual(before.population.map((m) => m.count), [1, 0], 'only the 21.154 m² wall is over 10 m² in the file');
  const [smallest] = (await preview({ kind: 'filter.proposal', name: 'Small', groups: [netSideArea('lt', 6.5)] })).samples;
  const wall = (await evaluateFilterGroupsFederated(evaluatorModelsFromState(state), [{ combinator: 'AND', rules: [{ kind: 'globalId', op: 'in', values: [smallest.globalId] }] }], { limit: 1 }))[0];
  try {
    // The 6.346 m² wall is edited to 12 m² and not saved.
    view.setQuantity(wall.expressId, 'Qto_WallBaseQuantities', 'NetSideArea', 12, QuantityType.Area);
    useViewerStore.setState({ mutationViews: new Map([[ARCH, view]]), mutationVersion: 1 });
    const after = await preview({ kind: 'filter.proposal', name: 'Large', groups: [netSideArea('gt', 10)] });
    assert.deepEqual(after.samples.map((row) => row.globalId).sort(), [smallest.globalId, before.samples[0].globalId].sort());
    const list = await preview({ kind: 'list.proposal', list: { name: 'Areas', entityTypes: ['IfcWall'], columns: [
      { id: 'area', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetSideArea' }] } });
    close(list.measures[0].total, 43.2914 - 6.346 + 12);
  } finally {
    useViewerStore.setState({ mutationViews: new Map() });
  }
});
