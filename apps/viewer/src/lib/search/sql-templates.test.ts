/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { listSqlTemplates, getSqlTemplate } from './sql-templates.js';

/**
 * Columns + tables the DuckDBIntegration actually registers — if a
 * template ever references something not in this catalog, it'll silently
 * break for users. Keeping this duplicated in the test is the honest
 * safety net without importing from the heavy @ifc-lite/query package.
 */
const KNOWN_TABLES = new Set([
  'entities', 'properties', 'quantities', 'relationships',
  'walls', 'doors', 'windows', 'slabs', 'columns', 'beams', 'spaces',
  'entity_properties', 'entity_quantities',
]);

const KNOWN_COLUMNS: Record<string, Set<string>> = {
  entities: new Set([
    'express_id', 'global_id', 'name', 'description', 'type',
    'object_type', 'has_geometry', 'is_type',
    'contained_in_storey', 'defined_by_type',
  ]),
  properties: new Set([
    'entity_id', 'pset_name', 'pset_global_id', 'prop_name', 'prop_type',
    'value_string', 'value_real', 'value_int', 'value_bool',
  ]),
  quantities: new Set([
    'entity_id', 'qset_name', 'quantity_name', 'quantity_type', 'value', 'formula',
  ]),
  relationships: new Set(['source_id', 'target_id', 'rel_type', 'rel_id']),
};

describe('sql-templates', () => {
  it('exposes a non-empty catalog', () => {
    const all = listSqlTemplates();
    assert.ok(all.length >= 5, 'at least five starter queries');
  });

  it('every template has id, label, description, and sql', () => {
    for (const t of listSqlTemplates()) {
      assert.ok(t.id.length > 0);
      assert.ok(t.label.length > 0);
      assert.ok(t.description.length > 0);
      assert.ok(t.sql.length > 0);
      assert.ok(t.sql.includes('SELECT') || t.sql.toUpperCase().includes('SELECT'));
    }
  });

  it('every template id is unique', () => {
    const ids = listSqlTemplates().map((t) => t.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  it('getSqlTemplate returns the requested template and undefined for unknown ids', () => {
    const all = listSqlTemplates();
    const first = all[0];
    assert.strictEqual(getSqlTemplate(first.id), first);
    assert.strictEqual(getSqlTemplate('does-not-exist'), undefined);
  });

  it('every FROM / JOIN target is a known table or view', () => {
    for (const t of listSqlTemplates()) {
      const sql = t.sql.toLowerCase();
      // Very light parsing — scan for tokens after FROM / JOIN that
      // identify the referenced relation. Aliases are optional.
      const re = /\b(?:from|join)\s+([a-z_]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) {
        const table = m[1];
        assert.ok(
          KNOWN_TABLES.has(table),
          `template "${t.id}" references unknown table/view "${table}"`,
        );
      }
    }
  });

  it('every qualified column (alias.column) uses a real column on its table', () => {
    // Resolve aliases of the form: FROM entities e | JOIN properties p ON ...
    for (const t of listSqlTemplates()) {
      const sql = t.sql;
      const aliasMap = new Map<string, string>();
      // Match "<table> <alias>" right after FROM / JOIN.
      const aliasRe = /\b(?:FROM|JOIN)\s+([a-zA-Z_]+)\s+([a-zA-Z_])(?:\s|,|$)/g;
      let am: RegExpExecArray | null;
      while ((am = aliasRe.exec(sql)) !== null) {
        aliasMap.set(am[2], am[1]);
      }
      // Now check every `<letter>.<column>` reference.
      const colRe = /\b([a-zA-Z_])\.([a-z_]+)/g;
      let cm: RegExpExecArray | null;
      while ((cm = colRe.exec(sql)) !== null) {
        const alias = cm[1];
        const column = cm[2];
        const table = aliasMap.get(alias);
        if (!table) continue; // unknown alias — skip (could be in a CTE)
        const cols = KNOWN_COLUMNS[table];
        if (!cols) continue; // alias points to a view — views are free-form
        assert.ok(
          cols.has(column),
          `template "${t.id}" references unknown column "${column}" on table "${table}"`,
        );
      }
    }
  });
});
