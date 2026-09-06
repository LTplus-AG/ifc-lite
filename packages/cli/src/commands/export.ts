/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite export <file.ifc> --format csv|json|ifc [options]
 *
 * Export IFC data to CSV, JSON, or IFC STEP format.
 * Supports type filtering, storey filtering, column selection (including quantities),
 * and schema conversion on export.
 */

import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { escapeCsvCell } from '@ifc-lite/export';
import { findPropertyInSets, findQuantityInSets } from '@ifc-lite/query';
import { createHeadlessContext } from '../loader.js';
import { getFlag, fatal, writeOutput, validateLimit } from '../output.js';
import { exportRustFormat } from './export-rust-formats.js';
import type { ComparisonOp } from '@ifc-lite/sdk';

/**
 * Parse a --where filter string into psetName, propName, operator, value.
 */
function parseWhereFilter(filter: string): { psetName: string; propName: string; operator: string; value?: string } {
  const dotIdx = filter.indexOf('.');
  if (dotIdx <= 0) {
    fatal(`Invalid --where syntax: "${filter}". Expected: PsetName.PropName[=Value]`);
  }

  const psetName = filter.slice(0, dotIdx);
  const rest = filter.slice(dotIdx + 1);

  for (const op of ['!=', '>=', '<=', '>', '<', '=', '~']) {
    const opIdx = rest.indexOf(op);
    if (opIdx > 0) {
      const propName = rest.slice(0, opIdx);
      const value = rest.slice(opIdx + op.length);
      const mappedOp = op === '~' ? 'contains' : op;
      return { psetName, propName, operator: mappedOp, value };
    }
  }

  return { psetName, propName: rest, operator: 'exists' };
}

/**
 * B9/F6: Auto-prefix Ifc for --type if user omits it.
 */
function normalizeTypeName(typeStr: string): string {
  return typeStr.split(',').map(t => {
    const trimmed = t.trim();
    if (trimmed.startsWith('Ifc') || trimmed.startsWith('IFC') || trimmed.startsWith('ifc')) {
      return trimmed;
    }
    const prefixed = 'Ifc' + trimmed;
    process.stderr.write(`Note: Auto-corrected type "${trimmed}" → "${prefixed}"\n`);
    return prefixed;
  }).join(',');
}

/**
 * B5: Resolve a column value from an entity, searching entity attributes,
 * property sets, AND quantity sets (by bare quantity name or QsetName.QuantityName).
 */
/**
 * Resolve a column value from an entity, returning the raw value
 * (number, boolean, string, or null) to preserve types in JSON output.
 */
export function resolveColumnValue(entity: any, col: string, bim: any): unknown {
  // Native entity attributes
  if (col === 'Name' || col === 'name') return entity.name ?? null;
  if (col === 'Type' || col === 'type') return entity.type ?? null;
  if (col === 'GlobalId' || col === 'globalId') return entity.globalId ?? null;
  if (col === 'Description' || col === 'description') return entity.description ?? null;
  if (col === 'ObjectType' || col === 'objectType') return entity.objectType ?? null;

  // Dot-separated: PsetName.PropName or QsetName.QuantityName
  const dotIdx = col.indexOf('.');
  if (dotIdx > 0) {
    const setName = col.slice(0, dotIdx);
    const valueName = col.slice(dotIdx + 1);

    // Search property sets
    const props = bim.properties(entity.ref);
    const prop = findPropertyInSets<any>(props, setName, valueName);
    if (prop?.value != null) return prop.value;

    // Search quantity sets
    const qsets = bim.quantities(entity.ref);
    const qty = findQuantityInSets<any>(qsets, setName, valueName);
    if (qty?.value != null) return qty.value;
    return null;
  }

  // B5: Bare quantity name (e.g., "GrossSideArea") — search all quantity sets
  const qsets = bim.quantities(entity.ref);
  for (const qset of qsets) {
    for (const q of qset.quantities) {
      if (q.name === col && q.value != null) return q.value;
    }
  }

  // Also search all property sets for bare property name
  const props = bim.properties(entity.ref);
  for (const pset of props) {
    for (const p of pset.properties) {
      if (p.name === col && p.value != null) return p.value;
    }
  }

  return null;
}

/** Stringify a column value for CSV output */
export function columnValueToCsv(value: unknown): string {
  if (value == null) return '';
  return String(value);
}

/**
 * RFC 4180 quoting + the CWE-1236 formula-injection guard, delegated to
 * `@ifc-lite/export`'s single escaper. The copy that used to live here tested
 * the trigger anchored at offset 0, so a BOM/ZWSP/LRM/NBSP/U+2028 in front of
 * `=` walked past it.
 */
function escapeCsv(value: string, sep: string): string {
  return escapeCsvCell(value, { delimiter: sep });
}

export async function exportCommand(args: string[]): Promise<void> {
  const filePath = args.find(a => !a.startsWith('-'));
  const format = getFlag(args, '--format') ?? 'csv';
  const outPath = getFlag(args, '--out');
  let type = getFlag(args, '--type');
  const columnsStr = getFlag(args, '--columns');
  const separator = getFlag(args, '--separator') ?? ',';
  const limit = getFlag(args, '--limit');
  const propFilter = getFlag(args, '--where');
  const storeyFilter = getFlag(args, '--storey');
  // Whole-model exports: geometry-backed (IFCX, USD) or analytic energy models
  // (HBJSON, DFJSON). None of them receive the isolated entity set — they re-read
  // the whole model from bytes — so the entity-isolation filters can only be
  // ignored. Skip filter processing entirely (an invalid/zero-match filter must
  // NOT abort an export the filter never applied to) and say so once, below.
  const wholeModelFormat =
    format === 'ifcx' || format === 'usd' || format === 'hbjson' || format === 'dfjson';
  const filterRequested = !!(type || propFilter || storeyFilter || limit);

  if (!filePath) fatal('Usage: ifc-lite export <file.ifc> --format csv|json|ifc|obj|gltf|glb|jsonld|step|ifcx|usd|hbjson|dfjson [--type IfcWall] [--columns Name,Type,GlobalId] [--where PsetName.Prop=Value] [--storey Name] [--name Model] [--out file]');

  // B9/F6: Auto-prefix Ifc
  if (type) {
    type = normalizeTypeName(type);
  }

  const { bim, store } = await createHeadlessContext(filePath);

  // Build entity query. Whole-model formats (ifcx/usd) skip all filtering so a bad or
  // zero-match filter can't abort the export.
  let q = bim.query();
  if (type && !wholeModelFormat) {
    q = q.byType(...type.split(','));
  }
  if (propFilter && !wholeModelFormat) {
    const parsed = parseWhereFilter(propFilter);
    q = q.where(parsed.psetName, parsed.propName, parsed.operator as ComparisonOp, parsed.value);
  }
  // Don't apply limit to the query yet — storey filtering must happen first
  let entities = q.toArray();

  // B4: --storey filter (applied before limit so --limit restricts storey-filtered results)
  if (storeyFilter && !wholeModelFormat) {
    const storeys = bim.storeys();
    const matchedStorey = storeys.find((s: any) =>
      s.name === storeyFilter ||
      s.name.toLowerCase().includes(storeyFilter.toLowerCase()) ||
      String(s.ref.expressId) === storeyFilter
    );
    if (!matchedStorey) {
      const names = storeys.map((s: any) => s.name).filter(Boolean).join(', ');
      fatal(`Storey "${storeyFilter}" not found. Available: ${names || '(none)'}`);
    }
    const contained = bim.contains(matchedStorey.ref);
    const storeyIds = new Set(contained.map((e: any) => e.ref.expressId));
    entities = entities.filter((e: any) => storeyIds.has(e.ref.expressId));
  }

  // Apply limit after storey filtering. A non-numeric/negative --limit used
  // to fall through to Array.prototype.slice(0, NaN), which silently returns
  // an empty array — a typo'd flag turned into a zero-row export reported as
  // success. validateLimit() rejects that loudly instead.
  //
  // Not for the whole-model formats, though: they never see `entities`, so the
  // limit has nothing to slice and cannot produce the zero-row export that
  // validation exists to prevent. Validating it anyway made `--limit` the one
  // entity filter that could still abort a whole-model export — the same
  // defect `--storey` had, which the `!wholeModelFormat` guards above fixed.
  // The ignored filter is still reported on stderr below.
  const parsedLimit = wholeModelFormat ? undefined : validateLimit(limit);
  if (parsedLimit !== undefined) {
    entities = entities.slice(0, parsedLimit);
  }

  const refs = entities.map((e: any) => e.ref);

  const columns = columnsStr
    ? columnsStr.split(',')
    : ['Type', 'Name', 'GlobalId', 'Description', 'ObjectType'];

  // Check if any columns need quantity/property resolution (non-native columns)
  const nativeColumns = new Set(['Name', 'name', 'Type', 'type', 'GlobalId', 'globalId', 'Description', 'description', 'ObjectType', 'objectType']);
  const hasCustomColumns = columns.some(c => !nativeColumns.has(c));

  // A filter on a whole-model format is ignored, not an error. Reported once here
  // rather than inside a single case, so every whole-model format says so — the
  // energy exporters used to accept `--type`/`--where`/`--limit` in silence.
  if (filterRequested && wholeModelFormat) {
    process.stderr.write(`Note: --type/--storey/--where/--limit do not apply to ${format.toUpperCase()}; exporting the whole model.\n`);
  }

  switch (format) {
    case 'csv': {
      if (hasCustomColumns) {
        // B5: Use our own CSV generation that supports quantity columns
        const rows: string[][] = [columns];
        for (const entity of entities) {
          rows.push(columns.map(col => columnValueToCsv(resolveColumnValue(entity, col, bim))));
        }
        const csv = rows.map(r => r.map(cell => escapeCsv(cell, separator)).join(separator)).join('\n');
        await writeOutput(csv, outPath);
      } else {
        const csv = bim.export.csv(refs, { columns, separator });
        await writeOutput(csv, outPath);
      }
      break;
    }
    case 'json': {
      if (hasCustomColumns) {
        // B5: Use our own JSON generation that supports quantity columns (raw values preserved)
        const result: Record<string, unknown>[] = [];
        for (const entity of entities) {
          const row: Record<string, unknown> = {};
          for (const col of columns) {
            row[col] = resolveColumnValue(entity, col, bim);
          }
          result.push(row);
        }
        const content = JSON.stringify(result, null, 2);
        await writeOutput(content, outPath);
      } else {
        const json = bim.export.json(refs, columns);
        const content = JSON.stringify(json, null, 2);
        await writeOutput(content, outPath);
      }
      break;
    }
    case 'ifc': {
      const schema = getFlag(args, '--schema') as 'IFC2X3' | 'IFC4' | 'IFC4X3' | undefined;
      // bim.export.ifc() isolates to the given refs (plus their reference closure)
      // whenever the array is non-empty, and treats an EMPTY array as "export the
      // whole model" — the same convention already used by the MCP export_ifc
      // tool, headless-test-helpers, and the mutate/playground call sites (#4044).
      // `refs` here is always non-empty for an unfiltered export (it's every
      // queryable entity), so passing it unconditionally used to isolate the
      // export to that set — narrowing out entities the query layer doesn't
      // surface directly (e.g. solids owned by non-product entities) even
      // though nothing was ever filtered.
      if (filterRequested && refs.length === 0) {
        fatal('Filter matched 0 entities — nothing to export. Check --type/--storey/--where/--limit.');
      }
      const exportRefs = filterRequested ? refs : [];
      const content = bim.export.ifc(exportRefs, { schema }) as string;
      if (!outPath) fatal('--out is required for IFC export');
      await writeFile(outPath, content, 'utf-8');
      if (filterRequested) {
        // A genuinely filtered export still narrows — report the delta so the
        // narrowing stays visible rather than silent (the same defect shape as
        // #4044, just for the case where narrowing is actually intended).
        const exportedCount = (content.match(/^#\d+=/gm) ?? []).length;
        process.stderr.write(
          `Exported ${exportedCount} of ${store.entityCount} entities (filtered) to ${outPath}\n`,
        );
      } else {
        process.stderr.write(`Written to ${outPath}\n`);
      }
      break;
    }
    // Rust-backed exporters (ifc-lite-export via wasm). OBJ/glTF mesh the model;
    // when a --type/--storey/--where/--limit filter is active the matched express
    // ids become the isolation set so the export contains only those elements.
    // See export-rust-formats.ts (#4047) for the shared wasm bootstrap and
    // per-format isolation/diagnostics handling.
    case 'obj':
    case 'gltf':
    case 'glb':
    case 'jsonld':
    case 'ifcx':
    case 'usd':
    case 'step': {
      await exportRustFormat(format, args, store, filePath, refs, filterRequested, wholeModelFormat);
      break;
    }
    case 'hbjson': {
      // Honeybee/Ladybug energy-model export via the SDK (the headless backend meshes
      // analytically through the wasm engine; the data-only SDK delegates to it).
      const name = getFlag(args, '--name') ?? basename(filePath).replace(/\.(ifc|ifcx|ifczip)$/i, '');
      const hbjson = await bim.export.hbjson({ name });
      await writeOutput(hbjson, outPath);
      break;
    }
    case 'dfjson': {
      // Dragonfly/Ladybug energy-model export (extruded Room2D plates) via the SDK.
      const name = getFlag(args, '--name') ?? basename(filePath).replace(/\.(ifc|ifcx|ifczip)$/i, '');
      const dfjson = await bim.export.dfjson({ name });
      await writeOutput(dfjson, outPath);
      break;
    }
    default:
      fatal(`Unknown format: ${format}. Supported: csv, json, ifc, obj, gltf, glb, jsonld, step, ifcx, usd, hbjson, dfjson`);
  }
}
