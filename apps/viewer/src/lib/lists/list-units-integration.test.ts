/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end regression for the #1573 list-export unit wiring. The original
 * #1580 shipped this feature DEAD: `executeList` resolved a column's
 * `quantityType`/`dataType`, but `ListPanel` rebuilt the result from the raw
 * `definition.columns`, dropping the annotation, so the export conversion never
 * fired. The piece-wise tests passed because they hand-fed annotated columns.
 *
 * This test runs the REAL chain (`executeList` -> `mergeResultColumns` ->
 * `buildExportModel`) over a stub provider and asserts a value gets converted
 * from an annotation the test itself never writes. It fails if any link stops
 * carrying the measure type.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { executeList, type ListDataProvider, type ListDefinition } from '@ifc-lite/lists';
import { IfcTypeEnum, QuantityType, type QuantitySet } from '@ifc-lite/data';
import { ProjectUnits } from '@ifc-lite/parser';
import { mergeResultColumns } from './merge-result-columns.js';
import { buildExportModel } from './export/model.js';

/** Minimal provider: one IfcWall with a NetVolume quantity (2.5, VOLUME). */
function stubProvider(qsets: QuantitySet[]): ListDataProvider {
  return {
    getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1] : []),
    getEntityName: () => 'Wall-1',
    getEntityGlobalId: (id) => `guid-${id}`,
    getEntityDescription: () => '',
    getEntityObjectType: () => '',
    getEntityTag: () => '',
    getEntityTypeName: () => 'IfcWall',
    getPropertySets: () => [],
    getQuantitySets: () => qsets,
  };
}

describe('list-export unit wiring end-to-end (#1573)', () => {
  it('converts a quantity column whose measure type only executeList knew', () => {
    // The column carries NO quantityType — executeList must resolve it.
    const definition: ListDefinition = {
      id: 'l1',
      name: 'Walls',
      createdAt: 0,
      updatedAt: 0,
      entityTypes: [IfcTypeEnum.IfcWall],
      conditions: [],
      columns: [{ id: 'vol', source: 'quantity', psetName: 'Qto', propertyName: 'NetVolume' }],
    };
    const provider = stubProvider([
      { name: 'Qto', quantities: [{ name: 'NetVolume', value: 2.5, type: QuantityType.Volume }] },
    ]);

    const result = executeList(definition, provider, 'm1');
    // executeList annotated the RESULT column; the authoring schema is untouched.
    assert.strictEqual(result.columns[0].quantityType, QuantityType.Volume);
    assert.strictEqual(definition.columns[0].quantityType, undefined);

    const merged = mergeResultColumns([result], definition.columns);
    assert.strictEqual(merged[0].quantityType, QuantityType.Volume);

    // Export with a Volume override to litres: 2.5 m³ -> 2500 L, header labeled.
    const modelUnits = new Map([['m1', ProjectUnits.empty()]]);
    const model = buildExportModel({
      title: 'Walls',
      columns: merged,
      rows: result.rows,
      numericCols: [true],
      columnWidths: [120],
      generatedAt: 'now',
      modelUnits,
      unitDisplayOverrides: { VOLUMEUNIT: 'l' },
    });

    assert.match(model.columns[0].label, /\(L\)/, 'header carries the target unit');
    const exported = model.rows[0][0];
    assert.ok(
      typeof exported === 'number' && Math.abs(exported - 2500) < 1e-6,
      `expected 2500 L, got ${String(exported)}`,
    );
  });

  it('leaves the column un-converted when the annotation is dropped (proves the assertion has teeth)', () => {
    // Simulate the #1580 bug: export from the raw definition columns (no merge).
    const definition: ListDefinition = {
      id: 'l1',
      name: 'Walls',
      createdAt: 0,
      updatedAt: 0,
      entityTypes: [IfcTypeEnum.IfcWall],
      conditions: [],
      columns: [{ id: 'vol', source: 'quantity', psetName: 'Qto', propertyName: 'NetVolume' }],
    };
    const provider = stubProvider([
      { name: 'Qto', quantities: [{ name: 'NetVolume', value: 2.5, type: QuantityType.Volume }] },
    ]);
    const result = executeList(definition, provider, 'm1');

    const model = buildExportModel({
      title: 'Walls',
      columns: definition.columns, // the bug: raw columns, annotation dropped
      rows: result.rows,
      numericCols: [true],
      columnWidths: [120],
      generatedAt: 'now',
      modelUnits: new Map([['m1', ProjectUnits.empty()]]),
      unitDisplayOverrides: { VOLUMEUNIT: 'l' },
    });
    // No annotation -> no conversion, no unit label: the raw 2.5 survives.
    assert.doesNotMatch(model.columns[0].label ?? '', /\(L\)/);
    assert.strictEqual(model.rows[0][0], 2.5);
  });
});
