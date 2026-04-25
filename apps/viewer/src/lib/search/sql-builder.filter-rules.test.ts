/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateSqlFromFilterRules } from './sql-builder.js';
import { Rule } from './filter-rules.js';

describe('generateSqlFromFilterRules — empty input', () => {
  it('returns "" when no rules provided', () => {
    assert.strictEqual(generateSqlFromFilterRules([]), '');
  });
});

describe('generateSqlFromFilterRules — set rules', () => {
  it('emits IN / NOT IN for ifcType', () => {
    const sql = generateSqlFromFilterRules([Rule.ifcType(['IfcWall', 'IfcDoor'])]);
    assert.match(sql, /e\.type IN \('IfcWall', 'IfcDoor'\)/);

    const negated = generateSqlFromFilterRules([Rule.ifcType(['IfcWall'], 'notIn')]);
    assert.match(negated, /e\.type NOT IN \('IfcWall'\)/);
  });

  it('emits FALSE for an empty IN list (vacuous match)', () => {
    const sql = generateSqlFromFilterRules([Rule.ifcType([])]);
    assert.match(sql, /\(FALSE\)/);
  });

  it('emits TRUE for an empty NOT IN list', () => {
    const sql = generateSqlFromFilterRules([Rule.ifcType([], 'notIn')]);
    assert.match(sql, /\(TRUE\)/);
  });
});

describe('generateSqlFromFilterRules — name rule', () => {
  it('eq is case-insensitive', () => {
    const sql = generateSqlFromFilterRules([Rule.name('eq', 'Wall-A')]);
    assert.match(sql, /LOWER\(e\.name\) = LOWER\('Wall-A'\)/);
  });

  it('contains escapes LIKE metacharacters', () => {
    const sql = generateSqlFromFilterRules([Rule.name('contains', '50%')]);
    // "50%" → "50\%" (escape the % so it isn't a wildcard).
    assert.ok(sql.includes("LIKE '%50\\%%' ESCAPE '\\'"), sql);
  });

  it('startsWith uses prefix LIKE', () => {
    const sql = generateSqlFromFilterRules([Rule.name('startsWith', 'EXT')]);
    assert.ok(sql.includes("LIKE 'ext%' ESCAPE '\\'"), sql);
  });
});

describe('generateSqlFromFilterRules — property rule', () => {
  it('isSet emits EXISTS', () => {
    const sql = generateSqlFromFilterRules([
      Rule.property('Pset_WallCommon', 'IsExternal', 'isSet', ''),
    ]);
    assert.match(sql, /EXISTS \(SELECT 1 FROM properties p/);
    assert.match(sql, /LOWER\(p\.pset_name\) = LOWER\('Pset_WallCommon'\)/);
    assert.match(sql, /LOWER\(p\.prop_name\) = LOWER\('IsExternal'\)/);
  });

  it('isNotSet emits NOT EXISTS', () => {
    const sql = generateSqlFromFilterRules([
      Rule.property('Pset_WallCommon', 'IsExternal', 'isNotSet', ''),
    ]);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM properties p/);
  });

  it('eq compares the COALESCE of typed columns', () => {
    const sql = generateSqlFromFilterRules([
      Rule.property('Pset_X', 'Status', 'eq', 'Approved'),
    ]);
    assert.match(sql, /COALESCE\(p\.value_string,/);
    assert.match(sql, /= LOWER\('Approved'\)/);
  });

  it('numeric op parses the rule value as a real and uses value_real', () => {
    const sql = generateSqlFromFilterRules([
      Rule.property('Pset_WallCommon', 'ThermalTransmittance', 'lt', '0.3'),
    ]);
    assert.match(sql, /COALESCE\(p\.value_real, CAST\(p\.value_int AS DOUBLE\)\) < 0\.3/);
  });
});

describe('generateSqlFromFilterRules — quantity rule', () => {
  it('emits EXISTS over quantities with numeric op', () => {
    const sql = generateSqlFromFilterRules([
      Rule.quantity('Qto_WallBaseQuantities', 'NetSideArea', 'gte', 5),
    ]);
    assert.match(sql, /EXISTS \(SELECT 1 FROM quantities q/);
    assert.match(sql, /q\.value >= 5/);
  });
});

describe('generateSqlFromFilterRules — combinator', () => {
  it('AND joins predicates with AND glue', () => {
    const sql = generateSqlFromFilterRules(
      [Rule.ifcType(['IfcWall']), Rule.name('contains', 'EXT')],
      { combinator: 'AND' },
    );
    assert.match(sql, /AND \(LOWER\(e\.name\)/);
  });

  it('OR joins predicates with OR glue', () => {
    const sql = generateSqlFromFilterRules(
      [Rule.ifcType(['IfcWall']), Rule.name('contains', 'EXT')],
      { combinator: 'OR' },
    );
    assert.match(sql, /OR \(LOWER\(e\.name\)/);
  });
});

describe('generateSqlFromFilterRules — limit & ordering', () => {
  it('appends LIMIT when > 0', () => {
    const sql = generateSqlFromFilterRules([Rule.ifcType(['IfcWall'])], { limit: 50 });
    assert.match(sql, /LIMIT 50;$/);
  });

  it('omits LIMIT when 0', () => {
    const sql = generateSqlFromFilterRules([Rule.ifcType(['IfcWall'])], { limit: 0 });
    assert.doesNotMatch(sql, /LIMIT/);
  });

  it('always orders by name for deterministic output', () => {
    const sql = generateSqlFromFilterRules([Rule.ifcType(['IfcWall'])]);
    assert.match(sql, /ORDER BY e\.name/);
  });
});

describe('generateSqlFromFilterRules — escaping', () => {
  it('doubles single quotes in user input', () => {
    const sql = generateSqlFromFilterRules([Rule.name('eq', "O'Brien")]);
    assert.match(sql, /LOWER\('O''Brien'\)/);
  });
});
