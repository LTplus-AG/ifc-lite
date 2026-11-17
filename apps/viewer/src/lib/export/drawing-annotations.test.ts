/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { IfcCreator } from '@ifc-lite/create';
import { IfcParser, effectiveMetadataRecord, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { prepareDrawingAnnotations, readDrawingAnnotations, restoredDrawingAnnotations, type DrawingAnnotations } from './drawing-annotations';

const localPython = join(homedir(), 'modelling-parity/venv/bin/python');
const python = process.env.IFCOPENSHELL_PYTHON ?? process.env.PARITY_PYTHON ?? (existsSync(localPython) ? localPython : 'python3');
const oracleAvailable = spawnSync(python, ['-c', 'import ifcopenshell, ifcopenshell.validate, pytest'], { stdio: 'ignore' }).status === 0;

const parse = (text: string | Uint8Array) => new IfcParser().parseColumnar(
  (typeof text === 'string' ? new TextEncoder().encode(text) : text).slice().buffer as ArrayBuffer);
const decode = (v: string | Uint8Array) => typeof v === 'string' ? v : new TextDecoder().decode(v);
const stable = (text: string) => text.replace(/(FILE_NAME\('(?:[^']|'')*',)'(?:[^']|'')*'/, "$1'<timestamp>'");
async function fixture(Schema: 'IFC2X3' | 'IFC4' | 'IFC4X3') {
  const creator = new IfcCreator({ Name: 'Annotations', Schema, Timestamp: 0 });
  creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const upper = creator.addIfcBuildingStorey({ Name: 'Upper', Elevation: 3 });
  creator.addIfcWall(upper, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
  const source = await parse(creator.toIfc().content);
  const storeyId = source.entityIndex.byType.get('IFCBUILDINGSTOREY')![0];
  const wall = source.entityIndex.byType.get('IFCWALL')![0];
  const input: DrawingAnnotations = {
    measures: [{ id: 'm', start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, distance: 5 }],
    dimensions: [{ id: 'd', a: { x: 0, y: 1 }, b: { x: 5, y: 1 }, offset: 0.5, orientation: 'aligned' }],
    tags: [{ tag: { id: 't', modelId: 'model', entityId: wall, anchor: { x: 2, y: 0 }, offset: { x: 0, y: 0.3 }, template: 'auto' }, label: 'T'.repeat(250) + ' · ≈ 1000 m²' }],
    plane: { axis: 'down', position: 1, flipped: false }, storeyId, paperScale: 100,
  };
  return { source, input };
}

for (const Schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
  it(`#9296: ${Schema} dimensions and bound tags survive IFC export/reopen/export`, async t => {
    const { source, input } = await fixture(Schema);
    const first = decode(new StepExporter(source, prepareDrawingAnnotations(source, undefined, input)).export({ schema: Schema }).content);
    const reopened = await parse(first);
    assert.equal(reopened.entityIndex.byType.get('IFCANNOTATION')?.length, 3);
    assert.equal(reopened.entityIndex.byType.get('IFCTEXTLITERAL')?.length, 3);
    assert.equal(reopened.entityIndex.byType.get('IFCRELASSIGNSTOPRODUCT')?.length, 1);
    const saved = readDrawingAnnotations(reopened);
    assert.equal(saved.length, 3);
    const tagId = saved.find(record => record.saved.item.kind === 'tag')!.id;
    assert.ok(Array.from(String(effectiveMetadataRecord(reopened, tagId)?.attributes[2])).length <= 255, 'IfcAnnotation.Name is an IfcLabel');
    assert.ok((reopened.entityIndex.byType.get('IFCTEXTLITERAL') ?? []).some(id => effectiveMetadataRecord(reopened, id)?.attributes[0] === input.tags[0].label), 'the literal retains the complete tag label');
    const tagContainment = (reopened.entityIndex.byType.get('IFCRELCONTAINEDINSPATIALSTRUCTURE') ?? [])
      .map(id => effectiveMetadataRecord(reopened, id)!.attributes).find(attrs => Array.isArray(attrs[4]) && attrs[4].includes(tagId));
    assert.equal(tagContainment?.[5], source.entityIndex.byType.get('IFCBUILDINGSTOREY')![1]);
    assert.deepEqual(saved[0].saved.item, { kind: 'measure', value: input.measures[0] });
    const restored = restoredDrawingAnnotations(reopened, 'new-model')!;
    assert.deepEqual(restored.measure2DResults, input.measures);
    assert.deepEqual(restored.dimensions2D, input.dimensions);
    assert.deepEqual(restored.tagAnnotations2D, [{ ...input.tags[0].tag, modelId: 'new-model' }]);
    const view = prepareDrawingAnnotations(reopened, undefined, input);
    const second = decode(new StepExporter(reopened, view).export({ schema: Schema }).content);
    assert.equal(stable(second), stable(first), 'unchanged reopen preserves every STEP record');
    const late = { ...input, measures: [{ ...input.measures[0], id: 'late-measure' }], dimensions: [], tags: [] };
    const kept = await parse(new StepExporter(reopened, prepareDrawingAnnotations(reopened, undefined, late)).export({ schema: Schema }).content);
    assert.equal(kept.entityIndex.byType.get('IFCANNOTATION')?.length, 4, 'markup never restored must survive a new edit');
    const cleared = await parse(new StepExporter(reopened, prepareDrawingAnnotations(reopened, undefined, { ...input, measures: [], dimensions: [], tags: [], absorbed: new Set(saved.map(record => record.identity)) })).export({ schema: Schema }).content);
    assert.equal(cleared.entityIndex.byType.get('IFCANNOTATION')?.length ?? 0, 0, 'an explicit clear removes only restored annotations');
    const mutations = new MutablePropertyView(reopened.properties, 'changed-guid');
    const { generateIfcGuid } = await import('@ifc-lite/encoding');
    mutations.setAttribute(tagId, 'GlobalId', generateIfcGuid());
    const retired = await parse(new StepExporter(reopened, prepareDrawingAnnotations(reopened, mutations, { ...input, measures: [], dimensions: [], tags: [], absorbed: new Set(saved.map(record => record.identity)) })).export({ schema: Schema }).content);
    assert.equal(retired.entityIndex.byType.get('IFCANNOTATION')?.length ?? 0, 0, 'edited GUIDs retain their source ownership identity');
    await t.test('EXPRESS validation of authored and cleared annotations', {
      skip: !oracleAvailable && !process.env.IFCOPENSHELL_PYTHON ? 'IfcOpenShell unavailable; schema-conformance CI runs this with IFCOPENSHELL_PYTHON' : false,
    }, () => {
      const folder = mkdtempSync(join(tmpdir(), 'annotations-'));
      try {
        const file = join(folder, 'export.ifc');
        for (const content of [first, decode(new StepExporter(cleared).export({ schema: Schema }).content), decode(new StepExporter(retired).export({ schema: Schema }).content)]) {
          writeFileSync(file, content);
          const result = spawnSync(python, [resolve('../../tools/ifcopenshell_reference/validate_export.py'), file], { encoding: 'utf8' });
          assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
        }
      } finally { rmSync(folder, { recursive: true, force: true }); }
    });
  });
  it(`#9296: ${Schema} no markup leaves export byte-identical`, async () => {
    const creator = new IfcCreator({ Name: 'Unchanged', Schema, Timestamp: 0 });
    creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
    const source = await parse(creator.toIfc().content);
    const before = decode(new StepExporter(source).export({ schema: Schema }).content);
    const after = decode(new StepExporter(source, prepareDrawingAnnotations(source, undefined, { measures: [], dimensions: [], tags: [], absorbed: new Set(), plane: { axis: 'down', position: 1, flipped: false }, paperScale: 100, storeyId: source.entityIndex.byType.get('IFCBUILDINGSTOREY')![0] })).export({ schema: Schema }).content);
    assert.equal(stable(after), stable(before));
  });
}

for (const Schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
  it(`#9296: ${Schema} missing context and stale storey do not break export`, async t => {
    const creator = new IfcCreator({ Name: 'No context', Schema, Timestamp: 0 });
    creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
    const base = await parse(creator.toIfc().content);
    const edits = new MutablePropertyView(base.properties, 'no-context');
    for (const type of ['IFCGEOMETRICREPRESENTATIONCONTEXT', 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT']) {
      for (const id of base.entityIndex.byType.get(type) ?? []) edits.deleteEntity(id);
    }
    edits.setPositionalAttribute(base.entityIndex.byType.get('IFCPROJECT')![0], 7, null);
    const storey = base.entityIndex.byType.get('IFCBUILDINGSTOREY')![0];
    edits.deleteEntity(Number(effectiveMetadataRecord(base, storey)?.attributes[5]));
    edits.setPositionalAttribute(storey, 5, null);
    const source = await parse(new StepExporter(base, edits).export({ schema: Schema }).content);
    const { input } = await fixture(Schema);
    const output = decode(new StepExporter(source, prepareDrawingAnnotations(source, undefined,
      { ...input, storeyId: 999999, dimensions: [], tags: [] })).export({ schema: Schema }).content);
    const reopened = await parse(output);
    assert.equal(reopened.entityIndex.byType.get('IFCANNOTATION')?.length, 1);
    assert.equal(reopened.entityIndex.byType.get('IFCGEOMETRICREPRESENTATIONCONTEXT')?.length, 1);
    await validate(t, [output]);
  });

  it(`#9296: ${Schema} adding a 3D annotation context preserves existing 2D references`, async t => {
    const creator = new IfcCreator({ Name: 'Plan context', Schema, Timestamp: 0 });
    creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
    const base = await parse(creator.toIfc().content);
    const edits = new MutablePropertyView(base.properties, 'plan-context');
    for (const type of ['IFCGEOMETRICREPRESENTATIONCONTEXT', 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT']) {
      for (const id of base.entityIndex.byType.get(type) ?? []) edits.deleteEntity(id);
    }
    const editor = new StoreEditor(base, edits);
    const point = editor.addEntity('IfcCartesianPoint', [[0, 0]]).expressId;
    const axes = editor.addEntity('IfcAxis2Placement2D', [`#${point}`, null]).expressId;
    const plan = editor.addEntity('IfcGeometricRepresentationContext', [null, 'Plan', 2, 1e-5, `#${axes}`, null]).expressId;
    const project = base.entityIndex.byType.get('IFCPROJECT')![0];
    edits.setPositionalAttribute(project, 7, [`#${plan}`]);
    const source = await parse(new StepExporter(base, edits).export({ schema: Schema }).content);
    const { input } = await fixture(Schema);
    const output = decode(new StepExporter(source, prepareDrawingAnnotations(source, undefined,
      { ...input, storeyId: source.entityIndex.byType.get('IFCBUILDINGSTOREY')![0], dimensions: [], tags: [] })).export({ schema: Schema }).content);
    const reopened = await parse(output);
    const contexts = ids(attribute(reopened, project, 7));
    assert.equal(contexts.length, 2);
    assert.equal(contexts[0], plan, 'the original plan context remains a reference');
    assert.deepEqual(contexts.map(id => attribute(reopened, id, 2)), [2, 3]);
    await validate(t, [output]);
  });

  it(`#9296: ${Schema} changed scale and offset change the actual annotation geometry`, async () => {
    const { source, input } = await fixture(Schema);
    input.dimensions[0].plane = { axis: 'front', position: 4, flipped: false };
    const first = await parse(new StepExporter(source, prepareDrawingAnnotations(source, undefined, input)).export({ schema: Schema }).content);
    const changed = await parse(new StepExporter(first, prepareDrawingAnnotations(first, undefined,
      { ...input, paperScale: 50, ifcOffset: [10, 0, 0], absorbed: new Set(readDrawingAnnotations(first).map(record => record.identity)) })).export({ schema: Schema }).content);
    const dim = readDrawingAnnotations(changed).find(record => record.saved.item.kind === 'dimension')!;
    assert.deepEqual(dim.saved.plane, input.dimensions[0].plane, 'persist the actual dimension cut');
    const lengths = curveLengths(changed, dim.id);
    assert.equal(lengths.filter(length => Math.abs(length - 0.125) < 1e-9).length, 2, 'two ticks at 1:50');
    const placement = Number(attribute(changed, dim.id, 5));
    const axis = Number(attribute(changed, placement, 1));
    const point = Number(attribute(changed, axis, 0));
    assert.deepEqual(attribute(changed, point, 0), [10, -4, 0]);
  });

  it(`#9296: ${Schema} reopening preserves annotations on other cuts`, async () => {
    const { source, input } = await fixture(Schema);
    const a = { ...input, dimensions: [], tags: [] };
    const first = await parse(new StepExporter(source, prepareDrawingAnnotations(source, undefined, a)).export({ schema: Schema }).content);
    const b = { ...a, measures: [{ ...a.measures[0], id: 'other-cut' }], plane: { axis: 'front' as const, position: 4, flipped: false } };
    const second = decode(new StepExporter(first, prepareDrawingAnnotations(first, undefined, b)).export({ schema: Schema }).content);
    const mixed = await parse(second);
    const restored = restoredDrawingAnnotations(mixed, 'reopened')!;
    assert.equal(restored.measure2DResults.length, 1, 'one drawing frame is restored at a time');
    const selected = readDrawingAnnotations(mixed).filter(record => record.saved.item.value.id === restored.measure2DResults[0].id);
    const third = decode(new StepExporter(mixed, prepareDrawingAnnotations(mixed, undefined, { ...a,
      measures: restored.measure2DResults, plane: restored.drawing2DPlane, absorbed: new Set(selected.map(record => record.identity)) })).export({ schema: Schema }).content);
    assert.equal(stable(third), stable(second), 'unrestored cuts retain their records and placements');
  });
}

async function validate(t: TestContext, contents: string[]) {
  await t.test('EXPRESS validation', { skip: !oracleAvailable && !process.env.IFCOPENSHELL_PYTHON ? 'IfcOpenShell unavailable; configured in schema-conformance CI' : false }, () => {
    const folder = mkdtempSync(join(tmpdir(), 'annotation-context-'));
    try {
      for (const content of contents) {
        const file = join(folder, 'export.ifc'); writeFileSync(file, content);
        const result = spawnSync(python, [resolve('../../tools/ifcopenshell_reference/validate_export.py'), file], { encoding: 'utf8' });
        assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
      }
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
}
const attribute = (store: IfcDataStore, id: number, index: number) => effectiveMetadataRecord(store, id)?.attributes[index];
const ids = (value: unknown): number[] => Array.isArray(value) ? value.filter((id): id is number => typeof id === 'number') : [];
function curveLengths(store: IfcDataStore, annotation: number): number[] {
  const product = Number(attribute(store, annotation, 6));
  return ids(attribute(store, product, 2)).flatMap(rep => ids(attribute(store, rep, 3))).flatMap(item => {
    if (effectiveMetadataRecord(store, item)?.type !== 'IfcPolyline') return [];
    const points = ids(attribute(store, item, 0)).map(id => attribute(store, id, 0));
    return points.length === 2 && Array.isArray(points[0]) && Array.isArray(points[1])
      ? [Math.hypot(Number(points[1][0]) - Number(points[0][0]), Number(points[1][1]) - Number(points[0][1]))] : [];
  });
}

it('#9296: drawing coordinates lift into the IFC plan and section planes', async () => {
  const { drawingPointInIfc } = await import('./drawing-annotations');
  assert.deepEqual(drawingPointInIfc({ x: 2, y: 3 }, { axis: 'down', position: 4, flipped: false }), [2, -3, 4]);
  assert.deepEqual(drawingPointInIfc({ x: 2, y: 3 }, { axis: 'front', position: 4, flipped: false }), [2, -4, 3]);
  assert.deepEqual(drawingPointInIfc({ x: 2, y: 3 }, { axis: 'side', position: 4, flipped: false }), [4, -2, 3]);
});

it('#9296: format reconciliation preserves distinct repeated markups and cuts', async () => {
  const { mergeRestoredMeasures, mergeRestoredDimensions } = await import('./drawing-annotation-restore');
  const measure = { id: 'saved-1', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, distance: 4 };
  const merged = mergeRestoredMeasures([measure, { ...measure, id: 'saved-2' }], [{ ...measure, id: 'automatic' }]);
  assert.deepEqual(merged.map(item => item.id), ['saved-2', 'automatic']);
  const dim = { id: 'saved', a: measure.start, b: measure.end, offset: 1, orientation: 'aligned' as const,
    plane: { axis: 'down' as const, position: 1, flipped: false } };
  assert.equal(mergeRestoredDimensions([dim], [{ ...dim, id: 'automatic', plane: { ...dim.plane, position: 4 } }]).length, 2);
});

it('#9296: equal IDs never merge measurements with distinct geometry', async () => {
  const { mergeRestoredMeasures } = await import('./drawing-annotation-restore');
  const saved = { id: 'automatic', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, distance: 4 };
  const automatic = { ...saved, end: { x: 7, y: 0 }, distance: 7 };
  assert.deepEqual(mergeRestoredMeasures([saved], [automatic]), [saved, automatic]);
});

it('#9296: reconciliation compares geometry even when another item shares the automatic ID', async () => {
  const { mergeRestoredMeasures } = await import('./drawing-annotation-restore');
  const a = { id: 'a', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, distance: 4 };
  const b = { ...a, id: 'b', end: { x: 7, y: 0 }, distance: 7 };
  const automatic = { ...a, id: 'b' };
  assert.deepEqual(mergeRestoredMeasures([a, b], [automatic]), [b, automatic]);
});

it('#9296: an equal item ID on another unabsorbed cut survives export', async () => {
  const { source, input } = await fixture('IFC4');
  const a = { ...input, dimensions: [], tags: [] };
  const first = await parse(new StepExporter(source, prepareDrawingAnnotations(source, undefined, a)).export({ schema: 'IFC4' }).content);
  const b = { ...a, plane: { axis: 'front' as const, position: 4, flipped: false } };
  const second = await parse(new StepExporter(first, prepareDrawingAnnotations(first, undefined, b)).export({ schema: 'IFC4' }).content);
  const records = readDrawingAnnotations(second);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.saved.plane), [a.plane, b.plane]);
});

it('#9296: float32 symbolic coordinates reconcile with full-precision measurements', async () => {
  const { mergeRestoredMeasures } = await import('./drawing-annotation-restore');
  const automatic = { id: 'a', start: { x: 12.3, y: 45.6 }, end: { x: 123.4, y: 567.8 }, distance: 533.89 };
  const points = new Float32Array([automatic.start.x, automatic.start.y, automatic.end.x, automatic.end.y]);
  const saved = { ...automatic, id: 'legacy', start: { x: points[0], y: points[1] }, end: { x: points[2], y: points[3] } };
  assert.deepEqual(mergeRestoredMeasures([saved], [automatic]), [automatic]);
  assert.equal(mergeRestoredMeasures([saved, saved], [automatic]).length, 2, 'one-to-one multiplicity survives');
  assert.equal(mergeRestoredMeasures([{ ...saved, end: { x: 125, y: 570 } }], [automatic]).length, 2, 'distinct geometry survives');
});

for (const variant of [{ paperScale: 50 }, { ifcOffset: [10, 0, 0] }]) {
  it(`#9296: an unabsorbed equal-ID frame survives ${JSON.stringify(variant)}`, async () => {
    const { source, input } = await fixture('IFC4');
    const a = { ...input, dimensions: [], tags: [] };
    const first = await parse(new StepExporter(source, prepareDrawingAnnotations(source, undefined, a)).export({ schema: 'IFC4' }).content);
    const b = { ...a, ...variant, measures: [{ ...a.measures[0], id: 'other' }] };
    const second = await parse(new StepExporter(first, prepareDrawingAnnotations(first, undefined, b)).export({ schema: 'IFC4' }).content);
    const other = readDrawingAnnotations(second).find(record => record.saved.item.value.id === 'other')!;
    other.saved.item.value.id = a.measures[0].id;
    const edit = new MutablePropertyView(second.properties, 'colliding-item-id');
    edit.setPositionalAttribute(other.id, 3, JSON.stringify(other.saved));
    const before = decode(new StepExporter(second, edit).export({ schema: 'IFC4' }).content);
    const mixed = await parse(before);
    const restored = restoredDrawingAnnotations(mixed, 'reopened')!;
    assert.equal(restored.measure2DResults.length, 1);
    const { restorableDrawingAnnotationRecords } = await import('./drawing-annotations');
    const selected = restorableDrawingAnnotationRecords(mixed);
    const reopenedInput = { ...a, measures: restored.measure2DResults, paperScale: restored.paperScale,
      absorbed: new Set(selected.map(record => record.identity)) };
    const after = decode(new StepExporter(mixed, prepareDrawingAnnotations(mixed, undefined, reopenedInput)).export({ schema: 'IFC4' }).content);
    assert.equal(stable(after), stable(before), 'unabsorbed frame retains all native records');
    const changed = await parse(new StepExporter(mixed, prepareDrawingAnnotations(mixed, undefined,
      { ...reopenedInput, ...variant })).export({ schema: 'IFC4' }).content);
    assert.equal(readDrawingAnnotations(changed).length, 2, 'editing the owned frame preserves its unabsorbed neighbour');
  });
}

for (const change of ['prefix', 'assignment'] as const) {
  it(`#9296: annotation geometry uses the exported length unit after ${change} changes`, async () => {
    const { source: base, input } = await fixture('IFC4');
    const lengthUnit = base.entityIndex.byType.get('IFCSIUNIT')!.find(id => String(effectiveMetadataRecord(base, id)?.attributes[1]).replaceAll('.', '') === 'LENGTHUNIT')!;
    assert.ok(lengthUnit);
    const mm = new MutablePropertyView(base.properties, 'millimetre-source');
    mm.setPositionalAttribute(lengthUnit, 2, '.MILLI.');
    const source = await parse(new StepExporter(base, mm).export({ schema: 'IFC4' }).content);
    const drawing = { ...input, dimensions: [], tags: [] };
    const withAnnotations = await parse(new StepExporter(source, prepareDrawingAnnotations(source, undefined, drawing)).export({ schema: 'IFC4' }).content);
    for (const store of [source, withAnnotations]) {
      const view = new MutablePropertyView(store.properties, 'metre-export');
      if (change === 'prefix') view.setPositionalAttribute(lengthUnit, 2, null);
      else {
        const editor = new StoreEditor(store, view);
        const unit = editor.addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', null, '.METRE.']).expressId;
        const assignment = editor.addEntity('IfcUnitAssignment', [[`#${unit}`]]).expressId;
        view.setPositionalAttribute(store.entityIndex.byType.get('IFCPROJECT')![0], 8, `#${assignment}`);
      }
      const prepared = prepareDrawingAnnotations(store, view, { ...drawing, absorbed: new Set(readDrawingAnnotations(store).map(record => record.identity)) });
      const exported = await parse(new StepExporter(store, prepared).export({ schema: 'IFC4' }).content);
      const { extractLengthUnitScale } = await import('@ifc-lite/parser');
      assert.equal(extractLengthUnitScale(exported.source, exported.entityIndex), 1);
      const annotation = readDrawingAnnotations(exported)[0];
      assert.deepEqual(curveLengths(exported, annotation.id), [5], '5 metres must remain 5 native metre units');
      const placement = Number(attribute(exported, annotation.id, 5));
      const axis = Number(attribute(exported, placement, 1));
      assert.deepEqual(attribute(exported, Number(attribute(exported, axis, 0)), 0), [0, 0, 1]);
    }
  });
}

it('#9296: choosing an off-plane first dimension preserves every exported frame', async () => {
  const { source, input } = await fixture('IFC4');
  const front = { ...input.dimensions[0], id: 'front-first', plane: { axis: 'front' as const, position: 4, flipped: false } };
  const plan = { ...input.dimensions[0], id: 'plan-second', plane: input.plane };
  const drawing = { ...input, measures: [], dimensions: [front, plan] };
  const before = decode(new StepExporter(source, prepareDrawingAnnotations(source, undefined, drawing)).export({ schema: 'IFC4' }).content);
  const store = await parse(before);
  const restored = restoredDrawingAnnotations(store, 'reopened')!;
  assert.deepEqual(restored.dimensions2D, [front]);
  const { restorableDrawingAnnotationRecords } = await import('./drawing-annotations');
  const prepared = prepareDrawingAnnotations(store, undefined, { ...drawing, dimensions: restored.dimensions2D, tags: [],
    plane: restored.drawing2DPlane, absorbed: new Set(restorableDrawingAnnotationRecords(store).map(record => record.identity)) });
  const after = decode(new StepExporter(store, prepared).export({ schema: 'IFC4' }).content);
  assert.equal(stable(after), stable(before), 'unrestored plan dimensions and bound tags retain every STEP record');
});

it('#9296: refuses unit changes with a retained frame instead of corrupting its native geometry', async () => {
  const { source: base, input } = await fixture('IFC4');
  const lengthUnit = base.entityIndex.byType.get('IFCSIUNIT')!.find(id => String(attribute(base, id, 1)).replaceAll('.', '') === 'LENGTHUNIT')!;
  const mm = new MutablePropertyView(base.properties, 'millimetre-frames');
  mm.setPositionalAttribute(lengthUnit, 2, '.MILLI.');
  const source = await parse(new StepExporter(base, mm).export({ schema: 'IFC4' }).content);
  const a = { ...input, dimensions: [], tags: [] };
  const first = await parse(new StepExporter(source, prepareDrawingAnnotations(source, undefined, a)).export({ schema: 'IFC4' }).content);
  const b = { ...a, measures: [{ ...a.measures[0], id: 'unabsorbed' }], plane: { axis: 'front' as const, position: 4, flipped: false } };
  const before = decode(new StepExporter(first, prepareDrawingAnnotations(first, undefined, b)).export({ schema: 'IFC4' }).content);
  const mixed = await parse(before);
  const records = readDrawingAnnotations(mixed);
  assert.equal(records.length, 2);
  assert.deepEqual(curveLengths(mixed, records[1].id), [5000], 'retained five-metre geometry is stored in millimetres');
  const restored = restoredDrawingAnnotations(mixed, 'reopened')!;
  assert.equal(restored.measure2DResults.length, 1);
  const owned = { ...a, measures: restored.measure2DResults, absorbed: new Set([records[0].identity]) };
  const metres = new MutablePropertyView(mixed.properties, 'metres-with-retained-frame');
  metres.setPositionalAttribute(lengthUnit, 2, null);
  const revision = metres.getMutationRevision();
  for (const drawing of [owned, { ...owned, measures: [] }, null]) {
    assert.throws(() => prepareDrawingAnnotations(mixed, metres, drawing), /Cannot change IFC length units.*retained annotations/);
    assert.equal(metres.getMutationRevision(), revision, 'refusal never mutates the live export view');
  }
  const { viewerDrawingAnnotations } = await import('./viewer-drawing-annotations');
  assert.throws(() => viewerDrawingAnnotations('not-the-active-model', mixed, metres), /Cannot change IFC length units.*retained annotations/);
  const unchanged = decode(new StepExporter(mixed, prepareDrawingAnnotations(mixed, undefined, owned)).export({ schema: 'IFC4' }).content);
  assert.equal(stable(unchanged), stable(before), 'unchanged units preserve every frame and native record');
});
