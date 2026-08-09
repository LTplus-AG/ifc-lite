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

import { writeFile, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { GeometryProcessor, isNoRenderGeometryError } from '@ifc-lite/geometry';
import { countGlbMeshes } from '@ifc-lite/export';
import { createHeadlessContext } from '../loader.js';
import { getFlag, hasFlag, fatal, writeOutput, validateLimit } from '../output.js';
import { logger } from '../logger.js';
import { formatGeometryReport, NO_DIAGNOSTICS_LINE } from '../geometry-report.js';
import type { ComparisonOp } from '@ifc-lite/sdk';
import type { IfcDataStore } from '@ifc-lite/parser';

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

/**
 * Resolve the raw IFC bytes (parsed store source, or re-read from disk) plus a
 * one-shot wasm GeometryProcessor for the Rust-backed exporters (OBJ / glTF / JSON-LD).
 *
 * Every Rust exporter below takes the WHOLE file, so the source is genuinely
 * materialised here (#2183). It is handed back rather than scoped through a
 * callback because the caller is one `switch` arm of a single CLI invocation
 * that also runs the optional diagnostics pass over the same bytes; the buffer
 * dies with the command.
 */
async function rustExportContext(
  store: IfcDataStore,
  filePath: string,
): Promise<{ bytes: Uint8Array; gp: GeometryProcessor }> {
  let bytes: Uint8Array;
  if (store.source.byteLength > 0) {
    bytes = store.source.materialize();
  } else {
    const buf = await readFile(filePath);
    bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const gp = new GeometryProcessor();
  await gp.init();
  return { bytes, gp };
}

function escapeCsv(value: string, sep: string): string {
  // CSV/formula-injection guard (CWE-1236): prefix a leading spreadsheet
  // formula trigger so Excel/Sheets treat the cell as text, not a formula.
  let str = value;
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(sep) || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
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
  const parsedLimit = validateLimit(limit);
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
      const content = bim.export.ifc(refs, { schema });
      if (!outPath) fatal('--out is required for IFC export');
      await writeFile(outPath, content, 'utf-8');
      process.stderr.write(`Written to ${outPath}\n`);
      break;
    }
    // Rust-backed exporters (ifc-lite-export via wasm). OBJ/glTF mesh the model;
    // when a --type/--storey/--where/--limit filter is active the matched express
    // ids become the isolation set so the export contains only those elements.
    case 'obj':
    case 'gltf':
    case 'glb':
    case 'jsonld':
    case 'ifcx':
    case 'usd':
    case 'step': {
      // Whole-model formats (ifcx/usd) never isolate, so filters were skipped above and
      // must not gate the export here — only the isolating formats treat a filter as active.
      const filterActive = !wholeModelFormat && filterRequested;
      const isolated = filterActive
        ? new Uint32Array(refs.map((r: any) => r.expressId))
        : new Uint32Array();
      // An empty isolation set means "export everything" to the Rust exporters, so a
      // filter that matched nothing would silently dump the whole model. Fail loudly
      // instead — the user asked for a subset and got zero matches.
      if (filterActive && isolated.length === 0) {
        fatal('Filter matched 0 entities — nothing to export. Check --type/--storey/--where/--limit.');
      }
      // --profile: attribute wall-time between the per-invocation wasm
      // bootstrap (GeometryProcessor init) and the export itself - the
      // fixed-overhead split the throughput plan needs for tiny inputs.
      const profileFlag = hasFlag(args, '--profile');
      const tInit = performance.now();
      const { bytes, gp } = await rustExportContext(store, filePath);
      if (profileFlag) {
        process.stderr.write(`profile: wasm init ${(performance.now() - tInit).toFixed(0)}ms\n`);
      }
      const tWork = performance.now();
      try {
        if (format === 'ifcx') {
          const out = gp.exportIfcx(bytes);
          if (out == null) fatal('IFCX export failed (geometry pipeline not initialized)');
          await writeOutput(out as Uint8Array, outPath);
        } else if (format === 'usd') {
          // OpenUSD (.usda ASCII) — whole-model Z-up USD stage (geometry-backed).
          const out = gp.exportUsd(bytes);
          if (out == null) fatal('USD export failed (geometry pipeline not initialized)');
          await writeOutput(out as Uint8Array, outPath);
        } else if (format === 'step') {
          // Rust faithful re-serialization (+ reference-closed subset when filtered).
          const schema = getFlag(args, '--schema') ?? '';
          const out = gp.exportStep(bytes, schema, isolated);
          if (out == null) fatal('STEP export failed (geometry pipeline not initialized)');
          await writeOutput(out as Uint8Array, outPath);
        } else if (format === 'jsonld') {
          const out = gp.exportJsonld(bytes, '', true, false, false, isolated);
          if (out == null) fatal('JSON-LD export failed (geometry pipeline not initialized)');
          await writeOutput(out as Uint8Array, outPath);
        } else if (format === 'obj') {
          const out = gp.exportObj(bytes, true, new Uint32Array(), isolated);
          if (out == null) fatal('OBJ export failed (geometry pipeline not initialized)');
          await writeOutput(out as Uint8Array, outPath);
        } else {
          // gltf | glb → binary GLB
          if (!outPath) fatal('--out is required for GLB/glTF export (binary output)');
          let out: Uint8Array | null;
          try {
            out = gp.exportGlb(bytes, false, new Uint32Array(), isolated, '');
          } catch (err) {
            // The Rust boundary fails closed on an empty visible mesh set; map
            // the typed error to the tailored operator hint.
            if (isNoRenderGeometryError(err)) {
              fatal(
                filterActive
                  ? 'GLB export produced 0 meshes — the matched entities have no exportable render geometry. Check --type/--storey/--where/--limit.'
                  : 'GLB export produced 0 meshes — the model has no exportable render geometry (or geometry production failed).',
              );
            }
            throw err;
          }
          if (out == null) fatal('GLB export failed (geometry pipeline not initialized)');
          // Defense-in-depth behind the Rust fail-closed guard: a zero-mesh GLB
          // must never be written to disk and reported as success.
          if (countGlbMeshes(out as Uint8Array) === 0) {
            fatal(
              filterActive
                ? 'GLB export produced 0 meshes — the matched entities have no exportable render geometry. Check --type/--storey/--where/--limit.'
                : 'GLB export produced 0 meshes — the model has no exportable render geometry (or geometry production failed).',
            );
          }
          logger.debug(`GLB meshes: ${countGlbMeshes(out as Uint8Array)}`);
          await writeFile(outPath, out as Uint8Array);
          logger.info(`Written to ${outPath}`);
        }
        if (profileFlag) {
          process.stderr.write(
            `profile: ${format} export ${(performance.now() - tWork).toFixed(0)}ms\n`,
          );
        }
        // Opt-in geometry summary (--diagnostics, or implied by --verbose):
        // reuses the gp/bytes already in scope. This is a second geometry pass
        // (the export bindings do not return diagnostics yet), so it only runs
        // when asked for; the renderer is shared with diagnose-geometry.
        if (hasFlag(args, '--diagnostics') || logger.level() === 'debug') {
          if (format === 'ifcx') {
            logger.info('No geometry diagnostics for ifcx export (no mesh pass).');
          } else {
            // Best-effort: the export already succeeded; a diagnostics failure
            // must not turn it into a command failure.
            try {
              const diag = gp.diagnoseGeometry(bytes);
              logger.info(diag ? formatGeometryReport(diag) : NO_DIAGNOSTICS_LINE);
            } catch (err) {
              logger.warn(
                `Geometry diagnostics failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      } finally {
        gp.dispose();
      }
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
