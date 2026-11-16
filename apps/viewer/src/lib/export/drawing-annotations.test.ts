/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { IfcCreator } from '@ifc-lite/create';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { prepareDrawingAnnotations, readDrawingAnnotations, restoredDrawingAnnotations, type DrawingAnnotations } from './drawing-annotations';

const localPython = join(homedir(), 'modelling-parity/venv/bin/python');
const python = process.env.IFCOPENSHELL_PYTHON ?? process.env.PARITY_PYTHON ?? (existsSync(localPython) ? localPython : 'python3');
const oracleAvailable = spawnSync(python, ['-c', 'import ifcopenshell, ifcopenshell.validate, pytest'], { stdio: 'ignore' }).status === 0;

const parse = (text: string | Uint8Array) => new IfcParser().parseColumnar(
  (typeof text === 'string' ? new TextEncoder().encode(text) : text).slice().buffer as ArrayBuffer);
const decode = (v: string | Uint8Array) => typeof v === 'string' ? v : new TextDecoder().decode(v);
const stable = (text: string) => text.replace(/(FILE_NAME\('(?:[^']|'')*',)'(?:[^']|'')*'/, "$1'<timestamp>'");
for (const Schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
  it(`#9296: ${Schema} dimensions and bound tags survive IFC export/reopen/export`, async t => {
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
      tags: [{ tag: { id: 't', modelId: 'model', entityId: wall, anchor: { x: 2, y: 0 }, offset: { x: 0, y: 0.3 }, template: 'auto' }, label: 'Wall mark' }],
      plane: { axis: 'down', position: 1, flipped: false }, storeyId, paperScale: 100,
    };
    const first = decode(new StepExporter(source, prepareDrawingAnnotations(source, undefined, input)).export({ schema: Schema }).content);
    const reopened = await parse(first);
    assert.equal(reopened.entityIndex.byType.get('IFCANNOTATION')?.length, 3);
    assert.equal(reopened.entityIndex.byType.get('IFCTEXTLITERAL')?.length, 3);
    assert.equal(reopened.entityIndex.byType.get('IFCRELASSIGNSTOPRODUCT')?.length, 1);
    const saved = readDrawingAnnotations(reopened);
    assert.equal(saved.length, 3);
    const { effectiveMetadataRecord } = await import('@ifc-lite/parser');
    const tagId = saved.find(record => record.saved.item.kind === 'tag')!.id;
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
    await t.test('EXPRESS validation of authored and cleared annotations', {
      skip: !oracleAvailable && !process.env.IFCOPENSHELL_PYTHON ? 'IfcOpenShell unavailable; schema-conformance CI runs this with IFCOPENSHELL_PYTHON' : false,
    }, () => {
      const folder = mkdtempSync(join(tmpdir(), 'annotations-'));
      try {
        const file = join(folder, 'export.ifc');
        for (const content of [first, decode(new StepExporter(cleared).export({ schema: Schema }).content)]) {
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
    const after = decode(new StepExporter(source, prepareDrawingAnnotations(source, undefined, null)).export({ schema: Schema }).content);
    assert.equal(stable(after), stable(before));
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
