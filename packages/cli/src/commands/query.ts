/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite query <file.ifc> [options]
 *
 * Query entities from an IFC file with type and property filters.
 * Supports all entity data: properties, quantities, materials,
 * classifications, attributes, relationships, type properties.
 */

import { createHeadlessContext } from '../loader.js';
import { printJson, getFlag, hasFlag, fatal } from '../output.js';
import { STANDARD_QTO_MAP, sortEntities } from './query-aggregation.js';
import { VALID_GROUP_BY_KEYS, outputCount, outputSum, outputAggregation, outputGroupBy, outputEntities } from './query-output.js';

/**
 * B9/F6: Auto-prefix Ifc for --type if user omits it.
 * Returns the corrected type string, or the original if already prefixed.
 */
function normalizeTypeName(typeStr: string): string {
  return typeStr.split(',').map(t => {
    const trimmed = t.trim();
    if (trimmed.startsWith('Ifc') || trimmed.startsWith('IFC') || trimmed.startsWith('ifc')) {
      return trimmed;
    }
    // Auto-prefix with Ifc
    const prefixed = 'Ifc' + trimmed;
    process.stderr.write(`Note: Auto-corrected type "${trimmed}" → "${prefixed}"\n`);
    return prefixed;
  }).join(',');
}

/**
 * Parse a --where filter string into psetName, propName, operator, value.
 * Supported formats:
 *   PsetName.PropName=Value     (equals)
 *   PsetName.PropName!=Value    (not equals)
 *   PsetName.PropName>Value     (greater than)
 *   PsetName.PropName<Value     (less than)
 *   PsetName.PropName>=Value    (greater or equal)
 *   PsetName.PropName<=Value    (less or equal)
 *   PsetName.PropName~Value     (contains)
 *   PsetName.PropName           (exists)
 */
function parseWhereFilter(filter: string): { psetName: string; propName: string; operator: string; value?: string } {
  const dotIdx = filter.indexOf('.');
  if (dotIdx <= 0) {
    fatal(`Invalid --where syntax: "${filter}". Expected: PsetName.PropName[=Value]`);
  }

  const psetName = filter.slice(0, dotIdx);
  const rest = filter.slice(dotIdx + 1);

  // Try multi-char operators first, then single-char
  for (const op of ['!=', '>=', '<=', '>', '<', '=', '~']) {
    const opIdx = rest.indexOf(op);
    if (opIdx > 0) {
      const propName = rest.slice(0, opIdx);
      const value = rest.slice(opIdx + op.length);
      const mappedOp = op === '~' ? 'contains' : op;
      return { psetName, propName, operator: mappedOp, value };
    }
  }

  // No operator found — exists check
  return { psetName, propName: rest, operator: 'exists' };
}

/**
 * B3/F1: Apply --where filter to entities, searching both property sets AND quantity sets.
 * Falls back to quantity sets when a property set match is not found.
 */
function applyWhereFilter(entities: any[], parsed: ReturnType<typeof parseWhereFilter>, bim: any): any[] {
  return entities.filter(e => {
    // First try property sets
    const props = bim.properties(e.ref);
    const pset = props.find((p: any) => p.name === parsed.psetName);
    if (pset) {
      const prop = pset.properties.find((p: any) => p.name === parsed.propName);
      if (prop) {
        if (parsed.operator === 'exists') return true;
        return compareValues(prop.value, parsed.operator, parsed.value);
      }
    }

    // B3: Also search quantity sets
    const qsets = bim.quantities(e.ref);
    const qset = qsets.find((q: any) => q.name === parsed.psetName);
    if (qset) {
      const qty = qset.quantities.find((q: any) => q.name === parsed.propName);
      if (qty) {
        if (parsed.operator === 'exists') return true;
        return compareValues(qty.value, parsed.operator, parsed.value);
      }
    }

    return false;
  });
}

function compareValues(actual: any, operator: string, expected: string | undefined): boolean {
  if (expected === undefined) return actual != null;
  const normActual = normalizeBooleanValue(actual);
  const normExpected = normalizeBooleanValue(expected);
  switch (operator) {
    case '=': return String(normActual) === String(normExpected);
    case '!=': return String(normActual) !== String(normExpected);
    case '>': return Number(normActual) > Number(normExpected);
    case '<': return Number(normActual) < Number(normExpected);
    case '>=': return Number(normActual) >= Number(normExpected);
    case '<=': return Number(normActual) <= Number(normExpected);
    case 'contains': return String(normActual).toLowerCase().includes(String(normExpected).toLowerCase());
    default: return false;
  }
}

function normalizeBooleanValue(value: unknown): unknown {
  if (value === true || value === '.T.' || value === 'true' || value === 'TRUE') return 'true';
  if (value === false || value === '.F.' || value === 'false' || value === 'FALSE') return 'false';
  return value;
}

export async function queryCommand(args: string[]): Promise<void> {
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) fatal('Usage: ifc-lite query <file.ifc> --type IfcWall [--props] [--limit N]');

  let type = getFlag(args, '--type');
  const limit = getFlag(args, '--limit');
  const offset = getFlag(args, '--offset');
  const propFilter = getFlag(args, '--where');
  const jsonOutput = hasFlag(args, '--json');
  const countOnly = hasFlag(args, '--count');
  const spatial = hasFlag(args, '--spatial');
  const sumQuantity = getFlag(args, '--sum');
  const avgQuantity = getFlag(args, '--avg');
  const minQuantity = getFlag(args, '--min');
  const maxQuantity = getFlag(args, '--max');
  const sortBy = getFlag(args, '--sort');
  const descSort = hasFlag(args, '--desc');
  const storeyFilter = getFlag(args, '--storey');
  const quantityNames = hasFlag(args, '--quantity-names');
  const propertyNames = hasFlag(args, '--property-names');
  const uniqueProp = getFlag(args, '--unique');
  const groupBy = getFlag(args, '--group-by');
  const spatialSummary = hasFlag(args, '--summary');

  // B9/F6: Auto-prefix Ifc for --type
  if (type) {
    type = normalizeTypeName(type);
  }

  const { bim } = await createHeadlessContext(filePath);

  // --quantity-names: list available quantities per entity type
  if (quantityNames) {
    const targetType = type;
    if (!targetType) fatal('--quantity-names requires --type (e.g., --type IfcWall --quantity-names)');

    const entities = bim.query().byType(...targetType.split(',')).limit(50).toArray();
    // Collect all quantity names seen, grouped by qset
    const qsetMap: Record<string, Map<string, { count: number; sampleValues: number[] }>> = {};

    for (const e of entities) {
      const qsets = bim.quantities(e.ref);
      for (const qset of qsets) {
        if (!qsetMap[qset.name]) qsetMap[qset.name] = new Map();
        const qmap = qsetMap[qset.name];
        for (const q of qset.quantities) {
          const existing = qmap.get(q.name);
          const numVal = Number(q.value) || 0;
          if (existing) {
            existing.count++;
            if (existing.sampleValues.length < 3) existing.sampleValues.push(numVal);
          } else {
            qmap.set(q.name, { count: 1, sampleValues: [numVal] });
          }
        }
      }
    }

    if (jsonOutput) {
      const result: Record<string, Record<string, unknown>> = {};
      for (const [qsetName, qmap] of Object.entries(qsetMap)) {
        result[qsetName] = {};
        for (const [qName, info] of qmap) {
          result[qsetName][qName] = {
            foundIn: `${info.count}/${entities.length} entities`,
            sampleValues: info.sampleValues,
            fullReference: `${qsetName}.${qName}`,
          };
        }
      }
      // Add standard reference if available
      const stdRef = STANDARD_QTO_MAP[targetType];
      if (stdRef) {
        printJson({ availableQuantities: result, standardReference: stdRef, note: 'Use --sum <QuantityName> to aggregate. Use full QsetName.QuantityName for unambiguous reference.' });
      } else {
        printJson({ availableQuantities: result, note: 'Use --sum <QuantityName> to aggregate.' });
      }
    } else {
      process.stdout.write(`\nQuantities available for ${targetType} (sampled ${entities.length} entities):\n\n`);
      for (const [qsetName, qmap] of Object.entries(qsetMap)) {
        process.stdout.write(`  ${qsetName}:\n`);
        for (const [qName, info] of qmap) {
          const samples = info.sampleValues.map(v => v.toFixed(2)).join(', ');
          process.stdout.write(`    ${qName}  (${info.count}/${entities.length} entities)  samples: [${samples}]\n`);
        }
        process.stdout.write('\n');
      }
      // Warn about ambiguity
      const allNames = new Map<string, string[]>();
      for (const [qsetName, qmap] of Object.entries(qsetMap)) {
        for (const qName of qmap.keys()) {
          const sets = allNames.get(qName) ?? [];
          sets.push(qsetName);
          allNames.set(qName, sets);
        }
      }
      const areaNames = [...allNames.entries()].filter(([name]) =>
        name.toLowerCase().includes('area') || name.toLowerCase().includes('surface'));
      if (areaNames.length > 1) {
        process.stderr.write(`WARNING: Multiple area quantities found. Choose carefully:\n`);
        for (const [name, sets] of areaNames) {
          process.stderr.write(`  - ${name} (in ${sets.join(', ')})\n`);
        }
        process.stderr.write(`  Use --sum <exact-name> with the correct quantity for your analysis.\n\n`);
      }
    }
    return;
  }

  // --property-names: list available properties per entity type
  if (propertyNames) {
    const targetType = type;
    if (!targetType) fatal('--property-names requires --type (e.g., --type IfcWall --property-names)');

    const entities = bim.query().byType(...targetType.split(',')).limit(50).toArray();
    const psetMap: Record<string, Map<string, { count: number; sampleValues: string[] }>> = {};

    for (const e of entities) {
      const psets = bim.properties(e.ref);
      for (const pset of psets) {
        if (!psetMap[pset.name]) psetMap[pset.name] = new Map();
        const pmap = psetMap[pset.name];
        for (const p of pset.properties) {
          const existing = pmap.get(p.name);
          const strVal = p.value != null ? String(p.value) : '';
          if (existing) {
            existing.count++;
            if (existing.sampleValues.length < 3 && strVal && !existing.sampleValues.includes(strVal)) {
              existing.sampleValues.push(strVal);
            }
          } else {
            pmap.set(p.name, { count: 1, sampleValues: strVal ? [strVal] : [] });
          }
        }
      }
    }

    if (jsonOutput) {
      const result: Record<string, Record<string, unknown>> = {};
      for (const [psetName, pmap] of Object.entries(psetMap)) {
        result[psetName] = {};
        for (const [propName, info] of pmap) {
          result[psetName][propName] = {
            foundIn: `${info.count}/${entities.length} entities`,
            sampleValues: info.sampleValues,
            filterPath: `${psetName}.${propName}`,
          };
        }
      }
      printJson({ availableProperties: result, note: 'Use --where PsetName.PropName=Value to filter.' });
    } else {
      process.stdout.write(`\nProperties available for ${targetType} (sampled ${entities.length} entities):\n\n`);
      for (const [psetName, pmap] of Object.entries(psetMap)) {
        process.stdout.write(`  ${psetName}:\n`);
        for (const [propName, info] of pmap) {
          const samples = info.sampleValues.length > 0 ? `  samples: [${info.sampleValues.map(v => `"${v}"`).join(', ')}]` : '';
          process.stdout.write(`    ${propName}  (${info.count}/${entities.length} entities)${samples}\n`);
        }
        process.stdout.write('\n');
      }
    }
    return;
  }

  // B6/F8: --unique: distinct values for a property path, material, or storey
  if (uniqueProp) {
    const targetType = type;
    if (!targetType) fatal('--unique requires --type (e.g., --type IfcWall --unique material)');

    const entities = bim.query().byType(...targetType.split(',')).toArray();
    const valueCounts = new Map<string, number>();

    if (uniqueProp === 'material') {
      // B6: Support --unique material
      for (const e of entities) {
        const mat = bim.materials(e.ref);
        const first = mat?.materials?.[0];
        const firstName = typeof first === 'string' ? first : first?.name;
        const val = firstName ?? mat?.name ?? '(no material)';
        valueCounts.set(val, (valueCounts.get(val) ?? 0) + 1);
      }
    } else if (uniqueProp === 'storey') {
      for (const e of entities) {
        const storey = bim.storey(e.ref);
        const val = storey?.name ?? '(no storey)';
        valueCounts.set(val, (valueCounts.get(val) ?? 0) + 1);
      }
    } else if (uniqueProp === 'type') {
      for (const e of entities) {
        valueCounts.set(e.type, (valueCounts.get(e.type) ?? 0) + 1);
      }
    } else {
      const dotIdx = uniqueProp.indexOf('.');
      if (dotIdx <= 0) fatal(`Invalid --unique path: "${uniqueProp}". Expected: PsetName.PropName, or one of: material, storey, type`);
      const psetName = uniqueProp.slice(0, dotIdx);
      const propName = uniqueProp.slice(dotIdx + 1);

      for (const e of entities) {
        const psets = bim.properties(e.ref);
        const pset = psets.find((p: any) => p.name === psetName);
        const prop = pset?.properties?.find((p: any) => p.name === propName);
        const val = prop?.value != null ? String(prop.value) : '(no value)';
        valueCounts.set(val, (valueCounts.get(val) ?? 0) + 1);
      }
    }

    if (jsonOutput) {
      const result: Record<string, number> = {};
      for (const [val, count] of valueCounts) result[val] = count;
      printJson({ property: uniqueProp, distinctValues: result, totalEntities: entities.length });
    } else {
      const sorted = [...valueCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [val, count] of sorted) {
        process.stdout.write(`${val} (${count})\n`);
      }
      process.stderr.write(`\n${sorted.length} distinct values across ${entities.length} entities\n`);
    }
    return;
  }

  // Spatial tree mode
  if (spatial) {
    const storeys = bim.storeys();
    const tree: Record<string, unknown[]> = {};

    if (storeys.length > 0) {
      for (const storey of storeys) {
        const contained = bim.contains(storey.ref);
        tree[storey.name || `Storey #${storey.ref.expressId}`] = contained.map((e: any) => ({
          type: e.type,
          name: e.name,
          globalId: e.globalId,
        }));
      }
    } else {
      // Fall back to buildings when no storeys exist
      const buildings = bim.query().byType('IfcBuilding').toArray();
      for (const building of buildings) {
        const contained = bim.contains(building.ref);
        tree[building.name || `Building #${building.ref.expressId}`] = contained.map((e: any) => ({
          type: e.type,
          name: e.name,
          globalId: e.globalId,
        }));
      }
      if (buildings.length === 0) {
        process.stderr.write('No storeys or buildings found in spatial structure\n');
      }
    }

    if (spatialSummary) {
      // Summary mode: type counts per storey instead of listing every element
      const summary: Record<string, Record<string, number>> = {};
      for (const [storeyName, elements] of Object.entries(tree)) {
        const counts: Record<string, number> = {};
        for (const elem of elements as Array<{ type: string; name: string; globalId: string }>) {
          counts[elem.type] = (counts[elem.type] || 0) + 1;
        }
        summary[storeyName] = counts;
      }
      if (jsonOutput) {
        printJson(summary);
      } else {
        for (const [storeyName, counts] of Object.entries(summary)) {
          const total = Object.values(counts).reduce((a, b) => a + b, 0);
          process.stdout.write(`\n  ${storeyName} (${total} elements):\n`);
          const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
          for (const [typeName, count] of sorted) {
            process.stdout.write(`    ${typeName}: ${count}\n`);
          }
        }
        process.stdout.write('\n');
      }
      return;
    }

    printJson(tree);
    return;
  }

  // Build query
  let q = bim.query();
  if (type) {
    const types = type.split(',');
    q = q.byType(...types);
  }

  // --storey filter: restrict to entities in a specific storey
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
    // Post-filter: only keep entities that are in this storey
    const baseEntities = q.toArray();
    let storeyEntities = baseEntities.filter((e: any) => storeyIds.has(e.ref.expressId));

    // B3: Apply --where filter to storey-filtered entities (with quantity support)
    if (propFilter) {
      const parsed = parseWhereFilter(propFilter);
      storeyEntities = applyWhereFilter(storeyEntities, parsed, bim);
    }

    const sAggQty = sumQuantity ?? avgQuantity ?? minQuantity ?? maxQuantity;
    const sAggMode: 'sum' | 'avg' | 'min' | 'max' | undefined = sumQuantity ? 'sum' : avgQuantity ? 'avg' : minQuantity ? 'min' : maxQuantity ? 'max' : undefined;
    if (groupBy && sAggQty) {
      outputGroupBy(storeyEntities, groupBy, sAggQty, bim, jsonOutput, limit ? parseInt(limit, 10) : undefined, sAggMode);
      return;
    }
    if (sumQuantity) {
      outputSum(storeyEntities, sumQuantity, bim, jsonOutput);
      return;
    }
    if (avgQuantity) {
      outputAggregation(storeyEntities, avgQuantity, 'avg', bim, jsonOutput);
      return;
    }
    if (minQuantity) {
      outputAggregation(storeyEntities, minQuantity, 'min', bim, jsonOutput);
      return;
    }
    if (maxQuantity) {
      outputAggregation(storeyEntities, maxQuantity, 'max', bim, jsonOutput);
      return;
    }
    if (groupBy) {
      outputGroupBy(storeyEntities, groupBy, undefined, bim, jsonOutput, limit ? parseInt(limit, 10) : undefined);
      return;
    }
    if (countOnly) {
      outputCount(storeyEntities.length, jsonOutput);
      return;
    }
    if (sortBy) {
      storeyEntities = sortEntities(storeyEntities, sortBy, descSort, bim);
    }
    outputEntities(storeyEntities, args, bim, jsonOutput);
    return;
  }

  // --where filter: search both property sets and quantity sets (B3)
  if (propFilter) {
    const parsed = parseWhereFilter(propFilter);
    // We need to do manual filtering to support quantity sets
    let entities = q.toArray();
    entities = applyWhereFilter(entities, parsed, bim);

    const whereAggQty = sumQuantity ?? avgQuantity ?? minQuantity ?? maxQuantity;
    const whereAggMode: 'sum' | 'avg' | 'min' | 'max' | undefined = sumQuantity ? 'sum' : avgQuantity ? 'avg' : minQuantity ? 'min' : maxQuantity ? 'max' : undefined;
    // When grouping, don't slice entities — pass limit as groupLimit instead
    if (groupBy && whereAggQty) {
      outputGroupBy(entities, groupBy, whereAggQty, bim, jsonOutput, limit ? parseInt(limit, 10) : undefined, whereAggMode);
      return;
    }
    if (groupBy) {
      outputGroupBy(entities, groupBy, undefined, bim, jsonOutput, limit ? parseInt(limit, 10) : undefined);
      return;
    }
    // Aggregations operate on the full filtered set (no offset/limit)
    if (sumQuantity) {
      outputSum(entities, sumQuantity, bim, jsonOutput);
      return;
    }
    if (avgQuantity) {
      outputAggregation(entities, avgQuantity, 'avg', bim, jsonOutput);
      return;
    }
    if (minQuantity) {
      outputAggregation(entities, minQuantity, 'min', bim, jsonOutput);
      return;
    }
    if (maxQuantity) {
      outputAggregation(entities, maxQuantity, 'max', bim, jsonOutput);
      return;
    }
    // Apply offset/limit only for non-aggregation, non-group paths
    if (offset) entities = entities.slice(parseInt(offset, 10));
    if (limit) entities = entities.slice(0, parseInt(limit, 10));
    if (countOnly) {
      outputCount(entities.length, jsonOutput);
      return;
    }
    if (sortBy) {
      entities = sortEntities(entities, sortBy, descSort, bim);
    }
    outputEntities(entities, args, bim, jsonOutput);
    return;
  }

  if (limit && !groupBy) q = q.limit(parseInt(limit, 10));
  if (offset) q = q.offset(parseInt(offset, 10));

  // B11: Validate --group-by key
  if (groupBy) {
    if (!VALID_GROUP_BY_KEYS.includes(groupBy) && !groupBy.includes('.')) {
      fatal(`Unknown grouping "${groupBy}". Valid options: ${VALID_GROUP_BY_KEYS.join(', ')}, or PsetName.PropName`);
    }
  }

  // Detect aggregation quantity and mode for --group-by combos
  const aggQuantity = sumQuantity ?? avgQuantity ?? minQuantity ?? maxQuantity;
  const aggMode: 'sum' | 'avg' | 'min' | 'max' | undefined = sumQuantity ? 'sum' : avgQuantity ? 'avg' : minQuantity ? 'min' : maxQuantity ? 'max' : undefined;

  // --group-by + aggregation combo: aggregate per group
  if (groupBy && aggQuantity) {
    const entities = q.toArray();
    // B12: pass limit to outputGroupBy to limit groups, not entities
    outputGroupBy(entities, groupBy, aggQuantity, bim, jsonOutput, limit ? parseInt(limit, 10) : undefined, aggMode);
    return;
  }

  // --sum mode: aggregate a quantity across matched entities
  if (sumQuantity) {
    const entities = q.toArray();
    outputSum(entities, sumQuantity, bim, jsonOutput);
    return;
  }

  // B7/F2: --avg mode
  if (avgQuantity) {
    const entities = q.toArray();
    outputAggregation(entities, avgQuantity, 'avg', bim, jsonOutput);
    return;
  }

  // B7/F2: --min mode
  if (minQuantity) {
    const entities = q.toArray();
    outputAggregation(entities, minQuantity, 'min', bim, jsonOutput);
    return;
  }

  // B7/F2: --max mode
  if (maxQuantity) {
    const entities = q.toArray();
    outputAggregation(entities, maxQuantity, 'max', bim, jsonOutput);
    return;
  }

  // --group-by mode: pivot table grouped by a property or 'type'/'material'
  if (groupBy) {
    const entities = q.toArray();
    // B12: pass limit to outputGroupBy to limit groups, not entities
    outputGroupBy(entities, groupBy, undefined, bim, jsonOutput, limit ? parseInt(limit, 10) : undefined);
    return;
  }

  if (countOnly) {
    const count = q.count();
    outputCount(count, jsonOutput);
    return;
  }

  let entities = q.toArray();

  // F7: --sort by quantity
  if (sortBy) {
    entities = sortEntities(entities, sortBy, descSort, bim);
  }

  outputEntities(entities, args, bim, jsonOutput);
}
