/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite schedule <file.ifc> [--preset <name>] --type <IfcClass>
 *                    --columns "<Header>=<path>[, ...]"
 *                    [--where "<expr>"] [--sort "<Header>[:asc|desc][, ...]"]
 *                    [--group-by "<Header>[, ...]"]
 *                    [--subtotals "<agg>[, ...]"] [--format csv|json]
 *
 * `--preset door|window|space|wall|material-takeoff` supplies a default
 * `--type` and `--columns` (and, for some presets, a default group-by/sort/
 * subtotals) so a common schedule runs with no other flags. An explicit flag of
 * the same name overrides the preset's default; `--where`/`--format` apply as
 * normal. See `schedule-presets.ts`.
 *
 * Produce a tabular schedule of one IFC class: pick the entities of `--type`,
 * (optionally) narrow them with the same `--where` filter `query` uses, and
 * emit one row per entity with the requested columns. A column path is a plain
 * attribute name, a `PsetName.PropName`, or a `QtoName.QtyName`, resolved
 * through the SAME resolver the `export` command uses so schedule columns and
 * query filters agree on type-inheritance / same-named-pset / complex-property
 * behaviour.
 *
 * `--sort`, `--group-by` and `--subtotals` all name column HEADERS (never
 * paths); a header that is not among `--columns` is a `fatal(...)`. Rows are
 * ordered by group first (so each group is contiguous) then by the remaining
 * sort keys, with the original entity order as the stable tiebreaker.
 * `--subtotals` emits a subtotal row after each group and a grand-total row;
 * without `--group-by` it emits only the grand total.
 */

import { createHeadlessContext } from '../loader.js';
import { getFlag, fatal, printJson } from '../output.js';
import { normalizeTypeName, parseWhereFilter, applyWhereFilter } from './query.js';
import { resolveColumnValue } from './export.js';
import { parseColumnSpec } from './schedule-columns.js';
import {
  renderScheduleCsv,
  renderScheduleJson,
  renderScheduleCsvWithSubtotals,
  renderScheduleJsonWithSubtotals,
  type ScheduleRow,
} from './schedule-render.js';
import { parseSortSpec, parseGroupBySpec, orderRows } from './schedule-group.js';
import { parseSubtotalsSpec, buildSubtotalPlan } from './schedule-aggregate.js';
import { resolvePreset } from './schedule-presets.js';

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
  // `Material` is a pseudo-column: resolve the element's associated material
  // name through the shared material accessor the `stats` command uses, rather
  // than a native attribute or a same-named property set member. `materials`
  // yields either a MaterialData whose `materials[]` list carries the leaf
  // names, or a single-material `name` — mirror the stats resolution order.
  if (path === 'Material') {
    const mat = bim.materials(entity.ref) as
      | { name?: string; materials?: Array<string | { name?: string }> }
      | null
      | undefined;
    const first = mat?.materials?.[0];
    const firstName = typeof first === 'string' ? first : first?.name;
    return firstName ?? mat?.name ?? null;
  }

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

  // --preset supplies default type/columns (and optionally group-by/sort/
  // subtotals); an explicit flag of the same name overrides the preset default.
  const presetName = getFlag(args, '--preset');
  const preset = presetName ? resolvePreset(presetName) : undefined;

  let type = getFlag(args, '--type') ?? preset?.type;
  if (!type) {
    fatal('--type is required (or pass --preset), e.g. --type IfcDoor or --preset door');
  }
  type = normalizeTypeName(type);

  const columns = parseColumnSpec(getFlag(args, '--columns') ?? preset?.columns);

  const format = (getFlag(args, '--format') ?? 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'json') {
    fatal(`Unknown --format "${format}". Expected csv or json.`);
  }

  const whereFilter = getFlag(args, '--where');

  // --sort / --group-by / --subtotals name declared column HEADERS; an unknown
  // header is a fatal(...) with the valid headers listed (raised during parse).
  const sortKeys = parseSortSpec(getFlag(args, '--sort') ?? preset?.sort, columns);
  const groupKeys = parseGroupBySpec(getFlag(args, '--group-by') ?? preset?.groupBy, columns);
  const subtotalAggs = parseSubtotalsSpec(getFlag(args, '--subtotals') ?? preset?.subtotals, columns);

  const { bim } = await createHeadlessContext(filePath);

  let entities = bim.query().byType(...type.split(',')).toArray();

  // --where reuses the exact query filter (property sets + quantity fallback).
  if (whereFilter) {
    const parsed = parseWhereFilter(whereFilter);
    entities = applyWhereFilter(entities, parsed, bim);
  }

  // One row per entity, in entity order — the stable tiebreaker for ordering.
  let rows: ScheduleRow[] = entities.map((e: any) =>
    columns.map(col => resolveScheduleValue(e, col.path, bim)),
  );

  // Order once, after row assembly: groups contiguous, then remaining sort keys.
  if (sortKeys.length > 0 || groupKeys.length > 0) {
    rows = orderRows(rows, sortKeys, groupKeys);
  }

  if (subtotalAggs.length > 0) {
    const plan = buildSubtotalPlan(rows, groupKeys, subtotalAggs);
    if (format === 'json') {
      printJson(renderScheduleJsonWithSubtotals(columns, plan));
      return;
    }
    process.stdout.write(renderScheduleCsvWithSubtotals(columns, plan) + '\n');
    return;
  }

  if (format === 'json') {
    printJson(renderScheduleJson(columns, rows));
    return;
  }

  process.stdout.write(renderScheduleCsv(columns, rows) + '\n');
}
