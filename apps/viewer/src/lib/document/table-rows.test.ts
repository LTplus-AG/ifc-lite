/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `resolveTableRows` over plain `ValidationReport` literals (#5138): no
 * engine, no parsed fixture — the report shape is the contract this module
 * reads, so a hand-built `source.kind: 'rules'` report exercises it exactly
 * the way the rule-set engine (PR 3) will populate the store.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EntityResult, SetResult, SpecificationResult, ValidationReport } from '@ifc-lite/ids';
import { resolveTableRows, TABLE_ROW_CAP } from './table-rows.js';
import type { TableBlock } from './types.js';

const entity = (overrides: Partial<EntityResult>): EntityResult => ({
  expressId: 1, modelId: 'm1', entityType: 'IfcWall', passed: true, requirementResults: [], ...overrides,
});

const spec = (id: string, name: string, overrides: Partial<SpecificationResult>): SpecificationResult => ({
  specification: { id, name },
  status: 'fail', applicableCount: 0, passedCount: 0, failedCount: 0, passRate: 0, entityResults: [], ...overrides,
});

function report(specs: SpecificationResult[]): ValidationReport {
  return {
    source: { kind: 'rules', ruleSet: { name: 'Rule set' } },
    modelInfo: [{ modelId: 'm1', schemaVersion: 'IFC4', entityCount: 10 }],
    timestamp: new Date('2026-09-21T00:00:00Z'),
    summary: { totalSpecifications: specs.length, passedSpecifications: 0, failedSpecifications: specs.length, totalEntitiesChecked: 0, totalEntitiesPassed: 0, totalEntitiesFailed: 0, overallPassRate: 0 },
    specificationResults: specs,
  };
}

const block = (overrides: Partial<TableBlock['source']>, columns: TableBlock['columns']): TableBlock => ({
  kind: 'table', id: 'b1', source: { kind: 'validation', rows: 'failed', ...overrides }, columns,
});

const modelName = (id: string): string => (id === 'm1' ? 'tower.ifc' : id);

describe('resolveTableRows (#5138)', () => {
  it('picks failed / passed / all entity rows, with the first failing requirement supplying actual/expected/reason', () => {
    const fail = entity({
      expressId: 41, entityType: 'IfcWall', entityName: 'Wall A', globalId: 'G-41', passed: false,
      requirementResults: [{ requirement: { id: 'r1', label: 'FireRating is set', optionality: 'required' }, status: 'fail', facetType: 'property', checkedDescription: '', failureReason: 'absent', actualValue: '', expectedValue: 'set' }],
    });
    const pass = entity({ expressId: 42, entityType: 'IfcDoor', entityName: 'Door B', globalId: 'G-42', passed: true });
    const oneSpec = spec('s1', 'Walls have FireRating', { entityResults: [fail, pass] });
    const columns: TableBlock['columns'] = ['rule', 'result', 'entityType', 'name', 'globalId', 'model', 'actual', 'expected', 'reason'];

    const failed = resolveTableRows(block({ rows: 'failed' }, columns), report([oneSpec]), modelName);
    assert.equal(failed.placeholderReason, null);
    assert.deepEqual(failed.rows, [['Walls have FireRating', 'fail', 'IfcWall', 'Wall A', 'G-41', 'tower.ifc', '', 'set', 'absent']]);

    const passed = resolveTableRows(block({ rows: 'passed' }, columns), report([oneSpec]), modelName);
    assert.deepEqual(passed.rows, [['Walls have FireRating', 'pass', 'IfcDoor', 'Door B', 'G-42', 'tower.ifc', '', '', '']]);

    const all = resolveTableRows(block({ rows: 'all' }, columns), report([oneSpec]), modelName);
    assert.equal(all.rows.length, 2);
  });

  it('rows: "sets" lists one row per SetResult, blank on entity-only columns', () => {
    const dup: SetResult = { kind: 'duplicate', label: 'Level 1', groupKey: 'Building', actual: 'Level 1 (2×)', expected: 'unique', passed: false, failureReason: 'duplicate', members: [{ modelId: 'm1', expressId: 41 }, { modelId: 'm1', expressId: 42 }] };
    const agg: SetResult = { kind: 'aggregate', label: 'sum(NetFloorArea)', actual: '287.4 m²', expected: '<= 300 m²', passed: true, members: [{ modelId: 'm1', expressId: 43 }] };
    const oneSpec = spec('s2', 'No duplicate storey names', { setResults: [dup, agg] });
    const columns: TableBlock['columns'] = ['rule', 'result', 'set', 'members', 'actual', 'expected', 'reason', 'entityType', 'name'];

    const resolved = resolveTableRows(block({ rows: 'sets' }, columns), report([oneSpec]), modelName);
    assert.deepEqual(resolved.rows, [
      ['No duplicate storey names', 'fail', 'Level 1 (Building)', '2', 'Level 1 (2×)', 'unique', 'duplicate', '', ''],
      ['No duplicate storey names', 'pass', 'sum(NetFloorArea)', '1', '287.4 m²', '<= 300 m²', '', '', ''],
    ]);
  });

  it('never throws on a null report; a stale ruleId is its own placeholder reason', () => {
    const columns: TableBlock['columns'] = ['rule', 'result'];
    const absent = resolveTableRows(block({}, columns), null, modelName);
    assert.deepEqual(absent, { columns, rows: [], truncated: false, placeholderReason: 'no-report' });

    const oneSpec = spec('s1', 'Walls have FireRating', {});
    const stale = resolveTableRows(block({ ruleId: 'gone' }, columns), report([oneSpec]), modelName);
    assert.deepEqual(stale, { columns, rows: [], truncated: false, placeholderReason: 'rule-not-found' });

    // A ruleId that DOES match narrows to that one specification only.
    const other = spec('s2', 'Other rule', { entityResults: [entity({ passed: false })] });
    const filtered = resolveTableRows(block({ ruleId: 's1', rows: 'all' }, ['rule']), report([oneSpec, other]), modelName);
    assert.deepEqual(filtered.rows, []); // s1 has no entityResults in this literal — proves it did NOT read s2
  });

  it('caps at 2 000 rows and reports truncation, without ever throwing', () => {
    const many = Array.from({ length: TABLE_ROW_CAP + 5 }, (_, i) => entity({ expressId: i, passed: false }));
    const oneSpec = spec('s1', 'Big rule', { entityResults: many });
    const resolved = resolveTableRows(block({ rows: 'failed' }, ['result']), report([oneSpec]), modelName);
    assert.equal(resolved.rows.length, TABLE_ROW_CAP);
    assert.equal(resolved.truncated, true);

    const exact = Array.from({ length: TABLE_ROW_CAP }, (_, i) => entity({ expressId: i, passed: false }));
    const exactResolved = resolveTableRows(block({ rows: 'failed' }, ['result']), report([spec('s1', 'x', { entityResults: exact })]), modelName);
    assert.equal(exactResolved.truncated, false, 'exactly the cap is not truncated');
  });
});
