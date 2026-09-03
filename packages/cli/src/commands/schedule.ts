/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite schedule <file.ifc> [--preset <name>] --type <IfcClass>
 *                    --columns "<Header>=<path>[, ...]"
 *                    [--where "<expr>"] [--sort "<Header>[:asc|desc][, ...]"]
 *                    [--group-by "<Header>[, ...]"]
 *                    [--subtotals "<agg>[, ...]"] [--format csv|json|md|html]
 *                    [--spec <file.json>] [--save <file.json>]
 *
 * `--preset door|window|space|wall|material-takeoff` supplies a default
 * `--type` and `--columns` (and, for some presets, a default group-by/sort/
 * subtotals) so a common schedule runs with no other flags. An explicit flag of
 * the same name overrides the preset's default; `--where`/`--format` apply as
 * normal. See `schedule-presets.ts`.
 *
 * `--spec <file.json>` loads a saved schedule definition (see
 * `schedule-spec.ts`) supplying the same defaults a preset would (lower
 * priority than an explicit flag, higher priority than `--preset`); `--save
 * <file.json>` writes the definition this invocation resolved to — after any
 * `--preset`/`--spec` defaults are folded in — so it can be re-run later with
 * `--spec` alone. A spec that names an unresolvable preset, isn't valid JSON,
 * or is missing both `type` and `preset` is a `fatal(...)`, never a silent
 * empty schedule.
 *
 * Produce a tabular schedule of one IFC class: pick the entities of `--type`,
 * (optionally) narrow them with the same `--where` filter `query` uses, and
 * emit one row per entity with the requested columns. A column path is a plain
 * attribute name, a `PsetName.PropName`, or a `QtoName.QtyName`, resolved
 * through the SAME resolver the `export` command uses so schedule columns and
 * query filters agree on type-inheritance / same-named-pset / complex-property
 * behaviour. `--format md` emits a GFM table; `--format html` emits a
 * standalone HTML document — both lay out `--group-by`/`--subtotals` rows
 * identically to CSV/JSON (see `schedule-render-md.ts`/`schedule-render-html.ts`)
 * and escape cell text for their format (`|`/newline for Markdown;
 * `&`/`<`/`>`/quotes for HTML — model text is untrusted).
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
import { renderScheduleMarkdown, renderScheduleMarkdownWithSubtotals } from './schedule-render-md.js';
import { renderScheduleHtml, renderScheduleHtmlWithSubtotals } from './schedule-render-html.js';
import { parseSortSpec, parseGroupBySpec, orderRows } from './schedule-group.js';
import { parseSubtotalsSpec, buildSubtotalPlan } from './schedule-aggregate.js';
import { resolvePreset } from './schedule-presets.js';
import { loadScheduleSpec, saveScheduleSpec, type ScheduleSpec } from './schedule-spec.js';

const FORMATS = ['csv', 'json', 'md', 'html'] as const;
type ScheduleFormat = (typeof FORMATS)[number];

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

  // --spec loads a saved definition (see schedule-spec.ts); its fields sit
  // between an explicit flag (wins) and a --preset default (loses) in
  // precedence, whether the preset comes from --preset or the spec's own
  // "preset" field.
  const specPath = getFlag(args, '--spec');
  const spec: ScheduleSpec | undefined = specPath ? await loadScheduleSpec(specPath) : undefined;

  // --preset supplies default type/columns (and optionally group-by/sort/
  // subtotals); an explicit flag of the same name overrides the preset default.
  const presetName = getFlag(args, '--preset') ?? spec?.preset;
  const preset = presetName ? resolvePreset(presetName) : undefined;

  const typeRaw = getFlag(args, '--type') ?? spec?.type ?? preset?.type;
  if (!typeRaw) {
    fatal('--type is required (or pass --preset/--spec), e.g. --type IfcDoor or --preset door');
  }
  const type = normalizeTypeName(typeRaw);

  const columnsSpec = getFlag(args, '--columns') ?? spec?.columns ?? preset?.columns;
  const columns = parseColumnSpec(columnsSpec);

  const format = (getFlag(args, '--format') ?? spec?.format ?? 'csv').toLowerCase();
  if (!FORMATS.includes(format as ScheduleFormat)) {
    fatal(`Unknown --format "${format}". Expected ${FORMATS.join(', ')}.`);
  }

  const whereFilter = getFlag(args, '--where') ?? spec?.where;

  // --sort / --group-by / --subtotals name declared column HEADERS; an unknown
  // header is a fatal(...) with the valid headers listed (raised during parse).
  const sortSpec = getFlag(args, '--sort') ?? spec?.sort ?? preset?.sort;
  const groupBySpec = getFlag(args, '--group-by') ?? spec?.groupBy ?? preset?.groupBy;
  const subtotalsSpec = getFlag(args, '--subtotals') ?? spec?.subtotals ?? preset?.subtotals;
  const sortKeys = parseSortSpec(sortSpec, columns);
  const groupKeys = parseGroupBySpec(groupBySpec, columns);
  const subtotalAggs = parseSubtotalsSpec(subtotalsSpec, columns);

  // --save persists the definition this invocation actually resolved to (after
  // --preset/--spec defaults are folded in), so the written file is self-
  // contained and reloadable with --spec alone.
  const savePath = getFlag(args, '--save');
  if (savePath) {
    await saveScheduleSpec(savePath, {
      type, columns: columnsSpec, where: whereFilter,
      sort: sortSpec, groupBy: groupBySpec, subtotals: subtotalsSpec, format,
    });
  }

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
    if (format === 'md') {
      process.stdout.write(renderScheduleMarkdownWithSubtotals(columns, plan) + '\n');
      return;
    }
    if (format === 'html') {
      process.stdout.write(renderScheduleHtmlWithSubtotals(columns, plan));
      return;
    }
    process.stdout.write(renderScheduleCsvWithSubtotals(columns, plan) + '\n');
    return;
  }

  if (format === 'json') {
    printJson(renderScheduleJson(columns, rows));
    return;
  }
  if (format === 'md') {
    process.stdout.write(renderScheduleMarkdown(columns, rows) + '\n');
    return;
  }
  if (format === 'html') {
    process.stdout.write(renderScheduleHtml(columns, rows));
    return;
  }

  process.stdout.write(renderScheduleCsv(columns, rows) + '\n');
}
