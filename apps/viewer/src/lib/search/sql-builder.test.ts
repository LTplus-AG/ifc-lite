/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  generateSqlFromBuilder,
  escapeSqlString,
  escapeLikePattern,
  emptyBuilderState,
  type VisualBuilderState,
  type PropertyFilter,
} from './sql-builder.js';

const pf = (overrides: Partial<PropertyFilter> = {}): PropertyFilter => ({
  psetName: 'Pset_WallCommon',
  propName: 'IsExternal',
  op: '=',
  valueType: 'bool',
  value: 'true',
  ...overrides,
});

describe('escapeSqlString', () => {
  it('doubles embedded single quotes', () => {
    assert.strictEqual(escapeSqlString("O'Brien"), "O''Brien");
  });
  it('leaves plain input untouched', () => {
    assert.strictEqual(escapeSqlString('wall'), 'wall');
  });
});

describe('escapeLikePattern', () => {
  it('escapes %, _, and \\ so values cannot smuggle wildcards in', () => {
    assert.strictEqual(escapeLikePattern('50%_x'), '50\\%\\_x');
    assert.strictEqual(escapeLikePattern('path\\to'), 'path\\\\to');
  });
});

describe('generateSqlFromBuilder', () => {
  it('returns empty string for the all-defaults empty state', () => {
    assert.strictEqual(generateSqlFromBuilder(emptyBuilderState()), '');
  });

  it('emits a type-only query when only ifcType is set', () => {
    const s: VisualBuilderState = { ...emptyBuilderState(), ifcType: 'IfcWall' };
    const sql = generateSqlFromBuilder(s);
    assert.ok(sql.includes('FROM entities e'));
    assert.ok(sql.includes("WHERE\n  e.type = 'IfcWall'"));
    assert.ok(sql.trim().endsWith(';'));
    assert.ok(sql.includes('LIMIT 500'));
  });

  it('joins properties once per filter and uses numbered aliases', () => {
    const s: VisualBuilderState = {
      ifcType: 'IfcWall',
      propertyFilters: [
        pf({ psetName: 'Pset_WallCommon', propName: 'IsExternal' }),
        pf({ psetName: 'Pset_WallCommon', propName: 'LoadBearing' }),
      ],
      limit: 100,
    };
    const sql = generateSqlFromBuilder(s);
    assert.ok(sql.includes('JOIN properties p1 ON p1.entity_id = e.express_id'));
    assert.ok(sql.includes('JOIN properties p2 ON p2.entity_id = e.express_id'));
    assert.ok(sql.includes("p1.pset_name = 'Pset_WallCommon'"));
    assert.ok(sql.includes("p2.pset_name = 'Pset_WallCommon'"));
    assert.ok(sql.includes('LIMIT 100'));
  });

  it('renders a bool equality predicate as TRUE / FALSE', () => {
    const s: VisualBuilderState = {
      ...emptyBuilderState(),
      ifcType: 'IfcWall',
      propertyFilters: [pf({ valueType: 'bool', value: 'true' })],
    };
    const sql = generateSqlFromBuilder(s);
    assert.ok(sql.includes('p1.value_bool = TRUE'));

    const s2 = { ...s, propertyFilters: [pf({ valueType: 'bool', value: 'false' })] };
    assert.ok(generateSqlFromBuilder(s2).includes('p1.value_bool = FALSE'));
  });

  it('renders numeric values for real and int types', () => {
    const sReal = generateSqlFromBuilder({
      ...emptyBuilderState(),
      ifcType: 'IfcWall',
      propertyFilters: [pf({ valueType: 'real', op: '>', value: '1.5' })],
    });
    assert.ok(sReal.includes('p1.value_real > 1.5'));

    const sInt = generateSqlFromBuilder({
      ...emptyBuilderState(),
      ifcType: 'IfcDoor',
      propertyFilters: [pf({ valueType: 'int', op: '<=', value: '42' })],
    });
    assert.ok(sInt.includes('p1.value_int <= 42'));
  });

  it('renders string equality with quoted values', () => {
    const sql = generateSqlFromBuilder({
      ...emptyBuilderState(),
      ifcType: 'IfcDoor',
      propertyFilters: [pf({ valueType: 'string', propName: 'FireRating', value: 'EI60' })],
    });
    assert.ok(sql.includes("p1.value_string = 'EI60'"));
  });

  it('renders contains as LIKE with escaped wildcards + ESCAPE clause', () => {
    const sql = generateSqlFromBuilder({
      ...emptyBuilderState(),
      ifcType: 'IfcDoor',
      propertyFilters: [pf({ op: 'contains', valueType: 'string', value: '50%_A' })],
    });
    assert.ok(sql.includes("LIKE '%50\\%\\_A%' ESCAPE '\\'"));
  });

  it("collapses contains→= when the value type isn't string", () => {
    const sql = generateSqlFromBuilder({
      ...emptyBuilderState(),
      ifcType: 'IfcDoor',
      propertyFilters: [pf({ op: 'contains', valueType: 'int', value: '5' })],
    });
    assert.ok(sql.includes('p1.value_int = 5'));
    assert.ok(!sql.includes('LIKE'));
  });

  it('escapes single quotes in pset / prop names and string values', () => {
    const sql = generateSqlFromBuilder({
      ...emptyBuilderState(),
      ifcType: "IfcWall'; DROP TABLE entities; --",
      propertyFilters: [pf({ psetName: "O'Brien", propName: "foo'bar", valueType: 'string', value: "quote's" })],
    });
    // Every literal must contain the doubled-quote escape.
    assert.ok(sql.includes("e.type = 'IfcWall''; DROP TABLE entities; --'"));
    assert.ok(sql.includes("p1.pset_name = 'O''Brien'"));
    assert.ok(sql.includes("p1.prop_name = 'foo''bar'"));
    assert.ok(sql.includes("p1.value_string = 'quote''s'"));
  });

  it('skips filters with empty psetName or propName', () => {
    const sql = generateSqlFromBuilder({
      ...emptyBuilderState(),
      ifcType: 'IfcWall',
      propertyFilters: [
        pf({ psetName: '', propName: 'Foo' }),
        pf({ psetName: 'Pset', propName: '' }),
        pf({ psetName: 'Pset_Real', propName: 'Valid' }),
      ],
    });
    assert.ok(sql.includes('JOIN properties p1'));
    assert.ok(!sql.includes('JOIN properties p2'));
    assert.ok(sql.includes("p1.pset_name = 'Pset_Real'"));
  });

  it('omits LIMIT when limit is 0 or negative', () => {
    const sql = generateSqlFromBuilder({
      ...emptyBuilderState(),
      ifcType: 'IfcWall',
      limit: 0,
    });
    assert.ok(!sql.includes('LIMIT'));
  });

  it('includes the matched pset.prop value as a self-describing result column', () => {
    const sql = generateSqlFromBuilder({
      ...emptyBuilderState(),
      ifcType: 'IfcWall',
      propertyFilters: [pf({ psetName: 'Pset_WallCommon', propName: 'IsExternal', valueType: 'bool' })],
    });
    assert.ok(sql.includes('p1.value_bool AS "Pset_WallCommon.IsExternal"'));
  });
});
