/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite schedule <file.ifc> --type <IfcClass> --columns "<Header>=<path>[, ...]"
 *                    [--where "<expr>"] [--format csv|json]
 *
 * Produce a tabular schedule of one IFC class: pick the entities of `--type`,
 * (optionally) narrow them with the same `--where` filter `query` uses, and
 * emit one row per entity with the requested columns. A column path is a plain
 * attribute name, a `PsetName.PropName`, or a `QtoName.QtyName`, resolved
 * through the SAME resolver the `export` command uses so schedule columns and
 * query filters agree on type-inheritance / same-named-pset / complex-property
 * behaviour.
 */

import { createHeadlessContext } from '../loader.js';
import { getFlag, fatal, printJson } from '../output.js';
import { normalizeTypeName, parseWhereFilter, applyWhereFilter } from './query.js';
import { resolveColumnValue } from './export.js';
import { parseColumnSpec } from './schedule-columns.js';
import { renderScheduleCsv, renderScheduleJson, type ScheduleRow } from './schedule-render.js';

/**
 * Resolve one column path against one entity.
 *
 * A `Set.Member` path (and the five native attributes) goes through the shared
 * `resolveColumnValue` the `export` command uses, so schedule columns inherit
 * its type-inheritance / same-named-pset / complex-property behaviour and agree
 * with `--where`. A plain attribute name the shared resolver does not treat as
 * native (e.g. `Tag`, `PredefinedType`) is then read from the canonical
 * entity-attribute list — the same surface `query --attributes` exposes — so a
 * missing value stays `null`.
 */
export function resolveScheduleValue(entity: any, path: string, bim: any): unknown {
  const viaColumn = resolveColumnValue(entity, path, bim);
  if (viaColumn != null) return viaColumn;

  if (!path.includes('.')) {
    const attrs = bim.attributes(entity.ref) as Array<{ name: string; value: unknown }>;
    const hit = attrs.find(a => a.name === path);
    if (hit && hit.value != null) return hit.value;
  }
  return null;
}

export async function scheduleCommand(args: string[]): Promise<void> {
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) {
    fatal('Usage: ifc-lite schedule <file.ifc> --type IfcDoor --columns "Name=Name, Mark=Pset_DoorCommon.Reference" [--where PsetName.Prop=Value] [--format csv|json]');
  }

  let type = getFlag(args, '--type');
  if (!type) {
    fatal('--type is required, e.g. --type IfcDoor');
  }
  type = normalizeTypeName(type);

  const columns = parseColumnSpec(getFlag(args, '--columns'));

  const format = (getFlag(args, '--format') ?? 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'json') {
    fatal(`Unknown --format "${format}". Expected csv or json.`);
  }

  const whereFilter = getFlag(args, '--where');

  const { bim } = await createHeadlessContext(filePath);

  let entities = bim.query().byType(...type.split(',')).toArray();

  // --where reuses the exact query filter (property sets + quantity fallback).
  if (whereFilter) {
    const parsed = parseWhereFilter(whereFilter);
    entities = applyWhereFilter(entities, parsed, bim);
  }

  // Preserve entity iteration order — no sorting in PR-1.
  const rows: ScheduleRow[] = entities.map((e: any) =>
    columns.map(col => resolveScheduleValue(e, col.path, bim)),
  );

  if (format === 'json') {
    printJson(renderScheduleJson(columns, rows));
    return;
  }

  process.stdout.write(renderScheduleCsv(columns, rows) + '\n');
}
