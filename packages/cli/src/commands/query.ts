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
import { printJson, getFlag, hasFlag, fatal, validateLimit } from '../output.js';
import { STANDARD_QTO_MAP, sortEntities } from './query-aggregation.js';
import { VALID_GROUP_BY_KEYS, outputCount, outputSum, outputAggregation, outputGroupBy, outputEntities, computeUniqueValues } from './query-output.js';
import { applyWhereFilter, parseWhereFilter, compareValues, normalizeBooleanValue } from './where-filter.js';

export { applyWhereFilter, parseWhereFilter, compareValues, normalizeBooleanValue };

/**
 * B9/F6: Auto-prefix Ifc for --type if user omits it.
 * Returns the corrected type string, or the original if already prefixed.
 */
export function normalizeTypeName(typeStr: string): string {
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

export async function queryCommand(args: string[]): Promise<void> {
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) fatal('Usage: ifc-lite query <file.ifc> --type IfcWall [--props] [--limit N]');

  let type = getFlag(args, '--type');
  const limit = getFlag(args, '--limit');
  // Both validated once, up front, and reused by every branch below (plain,
  // --where, --storey, --group-by). Each branch used to parse for itself,
  // and `parseInt` is truthy for any non-empty garbage: a typo'd --limit was
  // either ignored (`> 0`-shaped guards downstream) or silently emptied the
  // result (`slice(0, NaN)`), while --offset reached three different wrong
  // answers -- `slice(NaN)` inert, `slice(-2)` returning the LAST two entries
  // instead of skipping two, and NaN reaching the backend guard as an
  // uncaught TypeError. Every one of them exited 0 with a wrong answer.
  const rowLimit = validateLimit(limit);
  const offset = validateLimit(getFlag(args, '--offset'), '--offset');
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
    const valueCounts = computeUniqueValues(entities, uniqueProp, bim);

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
      outputGroupBy(storeyEntities, groupBy, sAggQty, bim, jsonOutput, rowLimit, sAggMode);
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
      outputGroupBy(storeyEntities, groupBy, undefined, bim, jsonOutput, rowLimit);
      return;
    }
    // Same slice the --where branch applies; without it both flags were inert here.
    if (offset) storeyEntities = storeyEntities.slice(offset);
    if (rowLimit !== undefined) storeyEntities = storeyEntities.slice(0, rowLimit);
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
      outputGroupBy(entities, groupBy, whereAggQty, bim, jsonOutput, rowLimit, whereAggMode);
      return;
    }
    if (groupBy) {
      outputGroupBy(entities, groupBy, undefined, bim, jsonOutput, rowLimit);
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
    // Non-aggregation, non-group paths only. `rowLimit` is validated up
    // front -- slice(0, NaN) used to silently empty the result.
    if (offset) entities = entities.slice(offset);
    if (rowLimit !== undefined) entities = entities.slice(0, rowLimit);
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

  // Detect aggregation quantity and mode up front: --sum/--avg/--min/--max
  // must run over the FULL filtered set, matching the --where and --storey
  // paths' explicit "no offset/limit" rule for aggregations -- a partial sum
  // over a --limit-sliced set is a silently wrong total, not a preview.
  const aggQuantity = sumQuantity ?? avgQuantity ?? minQuantity ?? maxQuantity;
  const aggMode: 'sum' | 'avg' | 'min' | 'max' | undefined = sumQuantity ? 'sum' : avgQuantity ? 'avg' : minQuantity ? 'min' : maxQuantity ? 'max' : undefined;

  // Validated, not parseInt'd -- the backend descriptor only honours the
  // limit under a `> 0` check, so a NaN --limit returned every match.
  // Both flags need both guards: !groupBy because the --where/--storey
  // siblings never slice before grouping, and !aggQuantity (#3510) because
  // an aggregation must run over the whole filtered set.
  if (rowLimit !== undefined && !groupBy && !aggQuantity) q = q.limit(rowLimit);
  if (offset && !groupBy && !aggQuantity) q = q.offset(offset);

  // B11: Validate --group-by key
  if (groupBy) {
    if (!VALID_GROUP_BY_KEYS.includes(groupBy) && !groupBy.includes('.')) {
      fatal(`Unknown grouping "${groupBy}". Valid options: ${VALID_GROUP_BY_KEYS.join(', ')}, or PsetName.PropName`);
    }
  }

  // --group-by + aggregation combo: aggregate per group
  if (groupBy && aggQuantity) {
    const entities = q.toArray();
    // B12: pass limit to outputGroupBy to limit groups, not entities
    outputGroupBy(entities, groupBy, aggQuantity, bim, jsonOutput, rowLimit, aggMode);
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
    outputGroupBy(entities, groupBy, undefined, bim, jsonOutput, rowLimit);
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
