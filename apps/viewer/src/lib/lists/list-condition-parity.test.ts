/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6190: every Lists-only predicate mode, carried in a Rules group as a
 * `listCondition` rule, keeps exactly the rows `executeList` keeps for the
 * same saved condition. Parsed IFC, one and two models, a live mutation
 * overlay on the second, and zone assignment plus zone volume data on both.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcTypeEnum } from '@ifc-lite/data';
import { executeList, type ListDefinition, type PropertyCondition } from '@ifc-lite/lists';
import { Rule, type FilterGroup, type ModelTag } from '@ifc-lite/rules';
import { runListFederated } from './run-list.js';
import { ZONE_SET, models } from './__fixtures__/list-condition-models.js';

const state = {
  models: new Map([['m1', {}], ['m2', {}]]),
  modelTags: new Map<string, ModelTag>(),
  modelTagAssignments: new Map<string, ReadonlySet<string>>(),
};
const definition = (groups: FilterGroup[]): ListDefinition => ({
  id: 'walls', name: 'Walls', createdAt: 0, updatedAt: 0, entityTypes: [IfcTypeEnum.IfcWall], groups,
  columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
});
const rows = (list: ReadonlyArray<{ modelId: string; entityId: number }>) =>
  list.map(({ modelId, entityId }) => `${modelId}:${entityId}`).sort();

/** One condition per mode the scoped compatibility editor offered, plus the executable remainder. */
const MODES: Record<string, PropertyCondition> = {
  'zone name': { source: 'zone', psetName: ZONE_SET.id, propertyName: 'Zone', operator: 'equals', value: 'Zone A' },
  'zone name of a straddler': { source: 'zone', psetName: ZONE_SET.id, propertyName: 'Zone', operator: 'contains', value: 'Zone B' },
  'zone straddles': { source: 'zone', psetName: ZONE_SET.id, propertyName: 'Straddles', operator: 'equals', value: 'true' },
  'zone volume (mesh)': { source: 'zone', psetName: ZONE_SET.id, propertyName: 'Volume (mesh)', operator: 'gt', value: '1.8' },
  'zone volume breakdown': { source: 'zone', psetName: ZONE_SET.id, propertyName: 'Volume breakdown (mesh)', operator: 'contains', value: 'Zone B' },
  'zone of an unknown set': { source: 'zone', psetName: 'zs-deleted', propertyName: 'Zone', operator: 'exists', value: '' },
  'spatial container': { source: 'spatial', propertyName: 'Container', operator: 'equals', value: 'Room 1' },
  'spatial storey': { source: 'spatial', propertyName: 'Storey', operator: 'equals', value: 'Level 1' },
  'spatial building': { source: 'spatial', propertyName: 'Building', operator: 'equals', value: 'Building A' },
  'spatial site': { source: 'spatial', propertyName: 'Site', operator: 'notEquals', value: 'Site B' },
  'spatial project': { source: 'spatial', propertyName: 'Project', operator: 'contains', value: 'tow' },
  'quantity presence': { source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetVolume', operator: 'exists', value: '' },
  'quantity comparison': { source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetVolume', operator: 'lt', value: '5' },
  'material presence': { source: 'material', propertyName: 'Material', operator: 'exists', value: '' },
  'material layer name': { source: 'material', propertyName: 'Material', operator: 'equals', value: 'core' },
  'material exclusion': { source: 'material', propertyName: 'Material', operator: 'notEquals', value: 'Brick' },
  'classification code': { source: 'classification', propertyName: 'Classification', operator: 'contains', value: 'ss_' },
  'model filename equals': { source: 'model', propertyName: 'Model', operator: 'equals', value: 'Model 2.ifc' },
  'model filename contains': { source: 'model', propertyName: 'Model', operator: 'contains', value: '1.IFC' },
  'pseudo-attribute GlobalId substring': { source: 'attribute', propertyName: 'GlobalId', operator: 'contains', value: 'Wall00000000000000003' },
  'pseudo-attribute Type presence': { source: 'attribute', propertyName: 'Type', operator: 'exists', value: '' },
  'pseudo-attribute Class': { source: 'attribute', propertyName: 'Class', operator: 'equals', value: 'IfcWall' },
  'attribute Tag presence': { source: 'attribute', propertyName: 'Tag', operator: 'exists', value: '' },
  'live-edited Name': { source: 'attribute', propertyName: 'Name', operator: 'contains', value: 'renamed' },
  'inherited property': { source: 'property', psetName: 'Pset_Assembly', propertyName: 'Mark', operator: 'equals', value: 'ASM', inherit: 'aggregation' },
  'inherited property presence': { source: 'property', psetName: 'Pset_Assembly', propertyName: 'Mark', operator: 'exists', value: '', inherit: 'aggregation' },
  'regex property name': { source: 'property', psetName: '/^Pset_Ass/', propertyName: 'Mark', operator: 'exists', value: '' },
  'world coordinate': { source: 'geometry', propertyName: 'X', operator: 'gte', value: '30' },
};

/** Modes that cannot split this fixture: one project per file, one class in scope, and a
 * zone set that no longer exists (durable id, so it matches nothing rather than another set). */
const UNIFORM: Record<string, 'all' | 'none'> = {
  'spatial project': 'all', 'pseudo-attribute Class': 'all', 'zone of an unknown set': 'none',
};

describe('#6190 listCondition rules match executeList on parsed IFC', () => {
  for (const [mode, condition] of Object.entries(MODES)) {
    it(`${mode}: same rows at one and two models`, async () => {
      const pairs = await models();
      const rule = Rule.listCondition(condition);
      for (const scope of [pairs.slice(0, 1), pairs]) {
        const scopedState = { ...state, models: new Map(scope.map(({ modelId }) => [modelId, {}])) };
        const expected = scope.flatMap(({ modelId, provider }) =>
          executeList({ ...definition([]), legacyConditions: [condition] }, provider, modelId).rows);
        const actual = await runListFederated(definition([{ combinator: 'AND', rules: [rule] }]), scope, scopedState);
        assert.deepEqual(rows(actual.rows), rows(expected), `${mode} at ${scope.length} model(s)`);
      }
      // The fixture must discriminate: across both models some wall is kept and some dropped.
      const all = await runListFederated(definition([]), pairs, state);
      const kept = await runListFederated(definition([{ combinator: 'AND', rules: [rule] }]), pairs, state);
      const uniform = UNIFORM[mode];
      if (uniform) assert.equal(kept.rows.length, uniform === 'all' ? all.rows.length : 0, mode);
      else assert.ok(kept.rows.length > 0 && kept.rows.length < all.rows.length, `${mode} keeps ${kept.rows.length} of ${all.rows.length} walls`);
    });
  }

  it('reads the live overlay: the deleted wall is gone and edited values count', async () => {
    const pairs = await models();
    const all = await runListFederated(definition([]), pairs, state);
    assert.deepEqual(rows(all.rows), ['m1:10', 'm1:20', 'm1:30', 'm1:35', 'm2:10', 'm2:30', 'm2:35']);
    const edited = await runListFederated(definition([{ combinator: 'AND', rules: [Rule.listCondition(MODES['quantity comparison'])] }]), pairs, state);
    // m2:35's NetVolume 9 exists only in the overlay and fails `lt 5`; m1:10's parsed 2.5 passes.
    assert.deepEqual(rows(edited.rows), ['m1:10', 'm2:10']);
  });

  it('a Lists predicate now composes under OR with a canonical rule', async () => {
    const pairs = await models();
    const zone = MODES['zone straddles'];
    const groups: FilterGroup[] = [{ combinator: 'OR', rules: [Rule.listCondition(zone), Rule.name('eq', 'Loose wall')] }];
    const result = await runListFederated(definition(groups), pairs, state);
    const straddlers = pairs.flatMap(({ modelId, provider }) =>
      executeList({ ...definition([]), legacyConditions: [zone] }, provider, modelId).rows);
    assert.deepEqual(rows(result.rows), [...new Set([...rows(straddlers), 'm1:35', 'm2:35'])].sort());
  });
});
