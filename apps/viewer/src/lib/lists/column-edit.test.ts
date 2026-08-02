/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Editing a list column IN PLACE (issue #1591 follow-up). The helpers must
 * keep the column's array position (order) and its id (the results table keys
 * per-column width by id and sort by index), while the DEFINITION change flows
 * through `executeList` so the re-run produces the new values.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeList, type ColumnDefinition, type ListDataProvider, type ListDefinition } from '@ifc-lite/lists';
import { IfcTypeEnum, PropertyValueType } from '@ifc-lite/data';
import { isEditableColumn, draftFromColumn, columnFromDraft, updateColumnInPlace } from './column-edit.js';

/** One IfcWall carrying two Pset_WallCommon properties to switch between. */
function stubProvider(): ListDataProvider {
  return {
    getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1] : []),
    getEntityName: () => 'Wall-1',
    getEntityGlobalId: (id) => `guid-${id}`,
    getEntityDescription: () => '',
    getEntityObjectType: () => '',
    getEntityTag: () => '',
    getEntityTypeName: () => 'IfcWall',
    getPropertySets: () => [
      { name: 'Pset_WallCommon', globalId: 'pset-guid', properties: [
        { name: 'FireRating', value: 'REI 90', type: PropertyValueType.Label },
        { name: 'AcousticRating', value: 'R52', type: PropertyValueType.Label },
      ]},
    ],
    getQuantitySets: () => [],
  };
}

const col = (id: string, propertyName: string, psetName = 'Pset_WallCommon'): ColumnDefinition => ({
  id,
  source: 'property',
  psetName,
  propertyName,
  label: propertyName,
});

describe('column edit in place (#1591 follow-up)', () => {
  it('only property/quantity columns (which carry a formula) are editable', () => {
    assert.equal(isEditableColumn(col('c1', 'FireRating')), true);
    assert.equal(isEditableColumn({ id: 'q', source: 'quantity', psetName: 'Qto', propertyName: 'NetVolume' }), true);
    assert.equal(isEditableColumn({ id: 'n', source: 'attribute', propertyName: 'Name' }), false);
    assert.equal(isEditableColumn({ id: 's', source: 'spatial', propertyName: 'Container' }), false);
    assert.equal(isEditableColumn({ id: 'm', source: 'material', propertyName: 'Material' }), false);
  });

  it('draft -> column round-trips the definition and PRESERVES the original id', () => {
    const original = col('custom-property-Pset_WallCommon-FireRating', 'FireRating');
    const draft = draftFromColumn(original);
    assert.deepEqual(draft, { source: 'property', setName: 'Pset_WallCommon', propName: 'FireRating' });
    const edited = columnFromDraft({ ...draft, propName: ' AcousticRating ' }, original.id);
    assert.equal(edited.id, original.id, 'id survives so width/sort keyed by id survive');
    assert.equal(edited.propertyName, 'AcousticRating', 'names are trimmed');
    assert.equal(edited.label, 'AcousticRating', 'label tracks the property, like add');
  });

  it('updateColumnInPlace keeps the column order and every other column untouched', () => {
    const columns: ColumnDefinition[] = [
      { id: 'name', source: 'attribute', propertyName: 'Name' },
      col('fire', 'FireRating'),
      { id: 'sto', source: 'spatial', propertyName: 'Storey' },
    ];
    const edited = columnFromDraft(
      { source: 'property', setName: 'Pset_WallCommon', propName: 'AcousticRating' },
      'fire',
    );
    const next = updateColumnInPlace(columns, 'fire', edited);
    assert.deepEqual(next.map((c) => c.id), ['name', 'fire', 'sto'], 'order + ids preserved');
    assert.equal(next[1].propertyName, 'AcousticRating');
    assert.equal(next[0], columns[0], 'other columns are the same objects');
    assert.equal(next[2], columns[2]);
    // A stale edit (column already removed) is a no-op.
    assert.equal(updateColumnInPlace(columns, 'gone', edited), columns);
  });

  it('re-running the list after an in-place edit yields the NEW values in the same slot', () => {
    const provider = stubProvider();
    const def: ListDefinition = {
      id: 'l1',
      name: 'Walls',
      createdAt: 0,
      updatedAt: 0,
      entityTypes: [IfcTypeEnum.IfcWall],
      conditions: [],
      columns: [
        { id: 'name', source: 'attribute', propertyName: 'Name' },
        col('fire', 'FireRating'),
      ],
    };
    const before = executeList(def, provider);
    assert.deepEqual(before.rows[0].values, ['Wall-1', 'REI 90']);

    // Pencil-edit: FireRating -> AcousticRating, same column slot.
    const draft = { ...draftFromColumn(def.columns[1]), propName: 'AcousticRating' };
    const columns = updateColumnInPlace(def.columns, 'fire', columnFromDraft(draft, 'fire'));
    const after = executeList({ ...def, columns }, provider);
    assert.deepEqual(after.rows[0].values, ['Wall-1', 'R52'], 'same slot, updated value');
    assert.equal(after.columns[1].id, 'fire');
  });
});
