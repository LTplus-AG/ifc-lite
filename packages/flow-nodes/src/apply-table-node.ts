/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `model.applyTable` — the pilot workflow's last step (issue #5167 phase
 * 3.2): typed table columns become property mutations through the ordinary
 * `bim.mutate` write path (the same guard/tracking every other write node
 * goes through — see `write-nodes.ts`'s doc for why read and write are kept
 * as distinct node kinds).
 *
 * A row is matched to an entity by its table's key column (`GlobalId` by
 * convention — `table.joinByKey`'s `matched` output already carries one).
 * Each applied column carries a `PropertyValueType` from its declared
 * `ColumnType` (`VALUE_TYPE_BY_COLUMN_TYPE`, `table-nodes.ts`); a cell that
 * does not parse as that type is reported PER ROW and not written — never
 * coerced to `0`/`''`/`false`, mirroring `csv-parse-value.ts`'s own
 * `PARSE_INVALID` contract, which this reuses rather than re-deriving.
 */

import { PARSE_INVALID, parseValue } from '@ifc-lite/mutations';
import type { Column, EntityRef } from '@ifc-lite/flow';
import { ENTITY_LIST, SCALAR_LIST, TABLE_ITEM, requireCapability, toSdkRef, type FlowNodeDef } from './host.js';
import { VALUE_TYPE_BY_COLUMN_TYPE, tableOf } from './table-nodes.js';

interface ColumnMapping {
  readonly column: string;
  readonly pset: string;
  readonly prop: string;
}

function isColumnMapping(v: unknown): v is ColumnMapping {
  const m = v as Partial<ColumnMapping>;
  return !!m && typeof m.column === 'string' && typeof m.pset === 'string' && typeof m.prop === 'string';
}

/** Resolve each column to write: an explicit `mapping` param entry wins,
 *  else the column's own `binding` (set by `table.fromEntities`). Columns
 *  with neither, and `list`-typed columns (not writable through
 *  `bim.mutate.setProperty`'s `string | number | boolean`), are skipped. */
function resolveMappings(columns: readonly Column[], mapping: unknown): { column: Column; pset: string; prop: string }[] {
  const explicit = new Map<string, ColumnMapping>();
  if (Array.isArray(mapping)) {
    for (const m of mapping) if (isColumnMapping(m)) explicit.set(m.column, m);
  }
  const out: { column: Column; pset: string; prop: string }[] = [];
  for (const column of columns) {
    const m = explicit.get(column.name) ?? (column.binding ? { column: column.name, pset: column.binding.pset, prop: column.binding.prop } : undefined);
    if (!m || column.type === 'list') continue;
    out.push({ column, pset: m.pset, prop: m.prop });
  }
  return out;
}

export const applyTableNode: FlowNodeDef = {
  type: 'model.applyTable',
  title: 'Apply table',
  category: 'model',
  doc: 'Writes typed table columns as property mutations, one entity per row (row key = GlobalId). A cell that does not parse as its column type is reported per row and not written.',
  inputs: [{ name: 'table', type: TABLE_ITEM }],
  outputs: [
    { name: 'entities', type: ENTITY_LIST },
    { name: 'problems', type: SCALAR_LIST },
  ],
  params: [
    {
      name: 'mapping',
      kind: 'json',
      doc: 'Optional [{ column, pset, prop }] overriding/supplying the pset.prop a column writes; columns already carrying a `binding` (from table.fromEntities) need no entry.',
      default: [],
    },
  ],
  capabilities: ['model.mutate:*'],
  writes: 'model',
  requires: { backend: ['mutate'] },
  run: (ctx, i, p) => {
    const t = tableOf(i.table);
    const mappings = resolveMappings(t.columns, p.mapping);
    if (mappings.length === 0) throw new Error('model.applyTable: no column has a mapping (pass "mapping" or use table.fromEntities columns)');

    const entities: EntityRef[] = [];
    const problems: string[] = [];
    for (const row of t.rows) {
      const gid = row[t.key];
      if (gid === null || gid === undefined || gid === '') {
        problems.push(`row with no "${t.key}": skipped`);
        continue;
      }
      const globalId = String(gid);
      let ref;
      try {
        ref = toSdkRef(ctx, { globalId });
      } catch (err) {
        problems.push(`${globalId}: ${(err as Error).message}`);
        continue;
      }
      for (const { column, pset, prop } of mappings) {
        requireCapability(ctx, `model.mutate:${pset}`);
        const raw = row[column.name];
        // An empty cell leaves the property as it is. ApplyTable NEVER deletes:
        // the readers encode an unparseable cell and a short row's missing
        // field as null too, so "null means delete" turned a typo in a
        // spreadsheet into silent data loss (#5377 review). Those cells were
        // already reported by the reader that produced them.
        // An empty string is empty too: `table.readCsv` keeps a string column's
        // blank cell as `''`, which would otherwise overwrite the value.
        if (raw === null || raw === undefined || raw === '') continue;
        // Re-parsed, not trusted: a table from any producer (not only this
        // package's readers) goes through the same whole-cell `parseValue`,
        // which refuses "12,5" rather than writing 12. Text is trimmed like
        // `CsvConnector`'s own cell splitter does.
        const parsed = parseValue(String(raw).trim(), VALUE_TYPE_BY_COLUMN_TYPE[column.type]);
        // A cell that fails to parse as its column's declared type is
        // reported and left unwritten — never coerced to 0/''/false. Other
        // columns on the same row still write; only this cell is skipped.
        if (parsed === PARSE_INVALID || parsed === null || Array.isArray(parsed)) {
          problems.push(`${globalId}: column "${column.name}": cannot parse "${String(raw)}" as ${column.type}`);
          continue;
        }
        ctx.host.bim.mutate.setProperty(ref, pset, prop, parsed);
      }
      entities.push({ globalId });
    }
    return { entities, problems };
  },
};
