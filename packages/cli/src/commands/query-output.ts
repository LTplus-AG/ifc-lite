/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Output formatting functions for the query command — count, sum,
 * aggregation, group-by, table rendering, and JSON serialization.
 */

import { findPropertyInSets } from '@ifc-lite/query';
import { printJson, formatTable, hasFlag, fatal, firstNonBlank } from '../output.js';
import { getQuantityValue } from './query-aggregation.js';

/** Valid built-in grouping keys */
export const VALID_GROUP_BY_KEYS = ['type', 'storey', 'material'];

export function outputCount(count: number, jsonOutput: boolean): void {
  if (jsonOutput) {
    printJson({ count });
  } else {
    process.stdout.write(`${count}\n`);
  }
}

export function outputSum(entities: any[], quantityName: string, bim: any, jsonOutput: boolean): void {
  let total = 0;
  let matched = 0;
  // Track all quantity names seen (for disambiguation warning)
  const allQuantityNames = new Map<string, { qsetName: string; count: number }>();
  const matchedQsets = new Set<string>();

  for (const e of entities) {
    const qsets = bim.quantities(e.ref);
    for (const qset of qsets) {
      for (const q of qset.quantities) {
        // Track all quantities for disambiguation
        const key = `${qset.name}.${q.name}`;
        const existing = allQuantityNames.get(key);
        if (existing) {
          existing.count++;
        } else {
          allQuantityNames.set(key, { qsetName: qset.name, count: 1 });
        }
        if (q.name === quantityName) {
          // Mirrors getQuantityValue in query-aggregation.ts: `Number(x) ||
          // 0` lets a present-but-Infinite value through (Infinity is
          // truthy), which would poison `total` for every other entity in
          // the sum. Number.isFinite catches NaN and both infinities.
          const n = Number(q.value);
          total += Number.isFinite(n) ? n : 0;
          matched++;
          matchedQsets.add(qset.name);
        }
      }
    }
  }

  // B10: Better error when quantity not found
  if (matched === 0 && entities.length > 0) {
    const availableNames = new Set<string>();
    for (const [key] of allQuantityNames) {
      availableNames.add(key.split('.').pop()!);
    }
    if (jsonOutput) {
      printJson({
        quantity: quantityName,
        total: 0,
        matchedEntities: 0,
        totalEntities: entities.length,
        error: `Quantity "${quantityName}" not found in any of the ${entities.length} entities.`,
        availableQuantities: [...availableNames],
        hint: 'Use --quantity-names --type <Type> to see all available quantities with details.',
      });
    } else {
      process.stdout.write(`0\n`);
      process.stderr.write(`Quantity "${quantityName}" not found in any of the ${entities.length} entities.\n`);
      if (availableNames.size > 0) {
        process.stderr.write(`Available quantities: ${[...availableNames].join(', ')}\n`);
      }
      process.stderr.write(`Use --quantity-names --type <Type> to see all available quantities.\n`);
    }
    return;
  }

  // Check for ambiguous area/volume quantities and warn
  const similarNames = [...allQuantityNames.entries()]
    .filter(([key]) => {
      const qName = key.split('.').pop()!.toLowerCase();
      const searchName = quantityName.toLowerCase();
      // Warn if there are other quantities with similar base concept (area, volume, etc.)
      if (searchName.includes('area')) return qName.includes('area') || qName.includes('surface');
      if (searchName.includes('volume')) return qName.includes('volume');
      if (searchName.includes('length')) return qName.includes('length');
      return false;
    })
    .filter(([key]) => key.split('.').pop() !== quantityName);

  if (jsonOutput) {
    const result: Record<string, unknown> = {
      quantity: quantityName,
      total,
      matchedEntities: matched,
      totalEntities: entities.length,
      fromQuantitySets: [...matchedQsets],
    };
    if (similarNames.length > 0) {
      result.warning = 'Other similar quantities exist — verify you are using the correct one';
      result.alternatives = similarNames.map(([key, info]) => ({
        name: key,
        foundInEntities: info.count,
      }));
    }
    printJson(result);
  } else {
    process.stdout.write(`${total}\n`);
    process.stderr.write(`${quantityName}: ${total} (from ${matched} of ${entities.length} entities, qsets: ${[...matchedQsets].join(', ')})\n`);
    if (similarNames.length > 0) {
      process.stderr.write(`\nWARNING: Other similar quantities exist in these entities:\n`);
      for (const [key, info] of similarNames) {
        process.stderr.write(`  - ${key} (${info.count} entities)\n`);
      }
      process.stderr.write(`  Verify you are summing the correct quantity for your analysis.\n`);
      process.stderr.write(`  Use --quantity-names --type <Type> to see all available quantities.\n`);
    }
  }
}

/**
 * B7/F2: --avg, --min, --max aggregation functions.
 */
export function outputAggregation(entities: any[], quantityName: string, mode: 'avg' | 'min' | 'max', bim: any, jsonOutput: boolean): void {
  let total = 0;
  let matched = 0;
  let minVal = Infinity;
  let maxVal = -Infinity;
  let minEntity: any = null;
  let maxEntity: any = null;

  for (const e of entities) {
    const val = getQuantityValue(bim, e.ref, quantityName);
    if (val !== null) {
      total += val;
      matched++;
      if (val < minVal) { minVal = val; minEntity = e; }
      if (val > maxVal) { maxVal = val; maxEntity = e; }
    }
  }

  // B10: quantity not found
  if (matched === 0) {
    if (jsonOutput) {
      printJson({ quantity: quantityName, error: `Quantity "${quantityName}" not found.`, hint: 'Use --quantity-names --type <Type> to see available quantities.' });
    } else {
      process.stderr.write(`Quantity "${quantityName}" not found in any of the ${entities.length} entities.\n`);
      process.stderr.write(`Use --quantity-names --type <Type> to see all available quantities.\n`);
    }
    return;
  }

  const avg = total / matched;
  const label = mode.charAt(0).toUpperCase() + mode.slice(1);

  if (jsonOutput) {
    const result: Record<string, unknown> = { quantity: quantityName, matchedEntities: matched, totalEntities: entities.length };
    if (mode === 'avg') {
      result.average = avg;
    } else if (mode === 'min') {
      result.min = minVal;
      if (minEntity) result.entity = { Name: minEntity.name, Type: minEntity.type, GlobalId: minEntity.globalId };
    } else {
      result.max = maxVal;
      if (maxEntity) result.entity = { Name: maxEntity.name, Type: maxEntity.type, GlobalId: maxEntity.globalId };
    }
    printJson(result);
  } else {
    if (mode === 'avg') {
      process.stdout.write(`${avg}\n`);
      process.stderr.write(`${label} ${quantityName}: ${avg.toFixed(4)} (${matched} entities)\n`);
    } else if (mode === 'min') {
      process.stdout.write(`${minVal}\n`);
      process.stderr.write(`${label} ${quantityName}: ${minVal} (${minEntity?.name ?? 'unknown'})\n`);
    } else {
      process.stdout.write(`${maxVal}\n`);
      process.stderr.write(`${label} ${quantityName}: ${maxVal} (${maxEntity?.name ?? 'unknown'})\n`);
    }
  }
}

export function outputGroupBy(entities: any[], groupByKey: string, sumQuantity: string | undefined, bim: any, jsonOutput: boolean, groupLimit?: number, aggMode?: 'sum' | 'avg' | 'min' | 'max'): void {
  // B11: Validate group-by key
  if (!VALID_GROUP_BY_KEYS.includes(groupByKey) && !groupByKey.includes('.')) {
    fatal(`Unknown grouping "${groupByKey}". Valid options: ${VALID_GROUP_BY_KEYS.join(', ')}, or PsetName.PropName`);
  }

  const groups = new Map<string, any[]>();

  for (const e of entities) {
    let groupValue: string;

    if (groupByKey === 'type') {
      groupValue = e.type;
    } else if (groupByKey === 'storey') {
      const storey = bim.storey(e.ref);
      groupValue = firstNonBlank(storey?.name) ?? '(no storey)';
    } else if (groupByKey === 'material') {
      const mat = bim.materials(e.ref);
      const first = mat?.materials?.[0];
      const firstMatName = typeof first === 'string' ? first : first?.name;
      groupValue = firstNonBlank(firstMatName, mat?.name) ?? '(no material)';
    } else if (groupByKey.includes('.')) {
      // PsetName.PropName
      const [psetName, propName] = groupByKey.split('.', 2);
      const props = bim.properties(e.ref);
      const prop = findPropertyInSets<any>(props, psetName, propName);
      groupValue = prop?.value != null ? String(prop.value) : `(no ${propName})`;
    } else {
      groupValue = e[groupByKey] ?? `(no ${groupByKey})`;
    }

    const existing = groups.get(groupValue);
    if (existing) {
      existing.push(e);
    } else {
      groups.set(groupValue, [e]);
    }
  }

  // Compute per-group aggregation if a quantity is specified alongside --group-by
  const mode = aggMode ?? 'sum';
  const groupAgg = new Map<string, number>();
  if (sumQuantity) {
    for (const [key, groupEntities] of groups) {
      let sum = 0;
      let count = 0;
      let minVal = Infinity;
      let maxVal = -Infinity;
      for (const e of groupEntities) {
        const val = getQuantityValue(bim, e.ref, sumQuantity);
        if (val !== null) {
          sum += val;
          count++;
          if (val < minVal) minVal = val;
          if (val > maxVal) maxVal = val;
        }
      }
      if (mode === 'avg') groupAgg.set(key, count > 0 ? sum / count : 0);
      else if (mode === 'min') groupAgg.set(key, count > 0 ? minVal : 0);
      else if (mode === 'max') groupAgg.set(key, count > 0 ? maxVal : 0);
      else groupAgg.set(key, sum);
    }
  }

  const modeLabel = mode === 'sum' ? 'sum' : mode;

  if (jsonOutput) {
    const result: Record<string, unknown> = {};
    let entries = [...groups.entries()];
    // B12: --limit limits groups, not entities
    if (groupLimit) entries = entries.slice(0, groupLimit);
    for (const [key, groupEntities] of entries) {
      const entry: Record<string, unknown> = { count: groupEntities.length };
      if (sumQuantity) entry[sumQuantity] = groupAgg.get(key) ?? 0;
      if (sumQuantity && mode !== 'sum') entry.aggregation = mode;
      result[key] = entry;
    }
    printJson(result);
  } else {
    let sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    // B12: --limit limits groups, not entities
    if (groupLimit) sorted = sorted.slice(0, groupLimit);
    process.stdout.write(`\nGrouped by ${groupByKey}${sumQuantity ? ` (${modeLabel}: ${sumQuantity})` : ''}:\n\n`);
    for (const [key, groupEntities] of sorted) {
      if (sumQuantity) {
        const agg = groupAgg.get(key) ?? 0;
        process.stdout.write(`  ${key}:  ${groupEntities.length} elements,  ${sumQuantity} ${modeLabel}: ${mode === 'avg' ? agg.toFixed(4) : agg}\n`);
      } else {
        process.stdout.write(`  ${key}: ${groupEntities.length}\n`);
      }
    }
    if (sumQuantity) {
      const grandTotal = [...groupAgg.values()].reduce((a, b) => a + b, 0);
      process.stdout.write(`\n  Total: ${entities.length} entities in ${groups.size} groups\n`);
      if (grandTotal === 0 && entities.length > 0) {
        process.stderr.write(`\n  Warning: All ${sumQuantity} values are 0. The file may not contain quantity data for this property.\n`);
      }
      process.stdout.write('\n');
    } else {
      process.stdout.write(`\n  Total: ${entities.length} entities in ${groups.size} groups\n\n`);
    }
  }
}

/**
 * B6/F8: `--unique` distinct-value counts for `material`, `storey`, `type`,
 * or a `PsetName.PropName` path. Pulled out of `queryCommand` so the
 * blank/whitespace-name handling (`firstNonBlank`) is unit-testable without
 * a fixture model.
 */
export function computeUniqueValues(entities: any[], uniqueProp: string, bim: any): Map<string, number> {
  const valueCounts = new Map<string, number>();

  if (uniqueProp === 'material') {
    for (const e of entities) {
      const mat = bim.materials(e.ref);
      const first = mat?.materials?.[0];
      const firstName = typeof first === 'string' ? first : first?.name;
      const val = firstNonBlank(firstName, mat?.name) ?? '(no material)';
      valueCounts.set(val, (valueCounts.get(val) ?? 0) + 1);
    }
  } else if (uniqueProp === 'storey') {
    for (const e of entities) {
      const storey = bim.storey(e.ref);
      const val = firstNonBlank(storey?.name) ?? '(no storey)';
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
      const prop = findPropertyInSets<any>(psets, psetName, propName);
      const val = prop?.value != null ? String(prop.value) : '(no value)';
      valueCounts.set(val, (valueCounts.get(val) ?? 0) + 1);
    }
  }

  return valueCounts;
}

export function outputEntities(entities: any[], args: string[], bim: any, jsonOutput: boolean): void {
  const showProps = hasFlag(args, '--props');
  const showQuantities = hasFlag(args, '--quantities');
  const showMaterials = hasFlag(args, '--materials');
  const showClassifications = hasFlag(args, '--classifications');
  const showAttributes = hasFlag(args, '--attributes');
  const showRelationships = hasFlag(args, '--relationships');
  const showTypeProps = hasFlag(args, '--type-props');
  const showDocuments = hasFlag(args, '--documents');
  const showAll = hasFlag(args, '--all');

  const needsDetail = showProps || showQuantities || showMaterials || showClassifications
    || showAttributes || showRelationships || showTypeProps || showDocuments || showAll;

  if (jsonOutput || needsDetail) {
    const result = entities.map((e: any) => {
      const entry: Record<string, unknown> = {
        type: e.type,
        name: e.name,
        globalId: e.globalId,
        description: e.description || undefined,
        objectType: e.objectType || undefined,
      };
      if (showAttributes || showAll) entry.attributes = bim.attributes(e.ref);
      if (showProps || showAll) entry.properties = bim.properties(e.ref);
      if (showQuantities || showAll) entry.quantities = bim.quantities(e.ref);
      if (showMaterials || showAll) entry.materials = bim.materials(e.ref);
      if (showClassifications || showAll) entry.classifications = bim.classifications(e.ref);
      if (showTypeProps || showAll) entry.typeProperties = bim.typeProperties(e.ref);
      if (showDocuments || showAll) entry.documents = bim.documents(e.ref);
      if (showRelationships || showAll) entry.relationships = bim.relationships(e.ref);
      return entry;
    });
    printJson(result);
    return;
  }

  // Table output
  const rows = entities.map((e: any) => [e.type, e.name, e.globalId]);
  process.stdout.write(formatTable(['Type', 'Name', 'GlobalId'], rows) + '\n');
  process.stderr.write(`\n${entities.length} entities\n`);
}
