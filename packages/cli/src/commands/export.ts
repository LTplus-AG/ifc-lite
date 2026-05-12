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
import { createHeadlessContext } from '../loader.js';
import { getFlag, hasFlag, fatal, writeOutput } from '../output.js';
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
function resolveColumnValue(entity: any, col: string, bim: any): unknown {
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
    const pset = props.find((p: any) => p.name === setName);
    if (pset) {
      const prop = pset.properties.find((p: any) => p.name === valueName);
      if (prop?.value != null) return prop.value;
    }

    // Search quantity sets
    const qsets = bim.quantities(entity.ref);
    const qset = qsets.find((q: any) => q.name === setName);
    if (qset) {
      const qty = qset.quantities.find((q: any) => q.name === valueName);
      if (qty?.value != null) return qty.value;
    }
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
function columnValueToCsv(value: unknown): string {
  if (value == null) return '';
  return String(value);
}

function escapeCsv(value: string, sep: string): string {
  if (value.includes(sep) || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
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

  if (!filePath) fatal('Usage: ifc-lite export <file.ifc> --format csv|json|ifc [--type IfcWall] [--columns Name,Type,GlobalId] [--where PsetName.Prop=Value] [--storey Name] [--out file]');

  // B9/F6: Auto-prefix Ifc
  if (type) {
    type = normalizeTypeName(type);
  }

  const { bim } = await createHeadlessContext(filePath);

  // Build entity query
  let q = bim.query();
  if (type) {
    q = q.byType(...type.split(','));
  }
  if (propFilter) {
    const parsed = parseWhereFilter(propFilter);
    q = q.where(parsed.psetName, parsed.propName, parsed.operator as ComparisonOp, parsed.value);
  }
  // Don't apply limit to the query yet — storey filtering must happen first
  let entities = q.toArray();

  // B4: --storey filter (applied before limit so --limit restricts storey-filtered results)
  if (storeyFilter) {
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

  // Apply limit after storey filtering
  if (limit) {
    entities = entities.slice(0, parseInt(limit, 10));
  }

  const refs = entities.map((e: any) => e.ref);

  const columns = columnsStr
    ? columnsStr.split(',')
    : ['Type', 'Name', 'GlobalId', 'Description', 'ObjectType'];

  // Check if any columns need quantity/property resolution (non-native columns)
  const nativeColumns = new Set(['Name', 'name', 'Type', 'type', 'GlobalId', 'globalId', 'Description', 'description', 'ObjectType', 'objectType']);
  const hasCustomColumns = columns.some(c => !nativeColumns.has(c));

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
      const content = bim.export.ifc(refs, { schema });
      if (!outPath) fatal('--out is required for IFC export');
      await writeFile(outPath, content, 'utf-8');
      process.stderr.write(`Written to ${outPath}\n`);
      break;
    }
    default:
      fatal(`Unknown format: ${format}. Supported: csv, json, ifc`);
  }
}
