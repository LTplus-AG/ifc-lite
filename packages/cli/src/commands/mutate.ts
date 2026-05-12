/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite mutate <file.ifc> --id N --set PsetName.PropName=Value --out output.ifc
 *
 * Modify properties or attributes of IFC entities and save the result.
 * Uses MutablePropertyView + StepExporter for real mutation persistence.
 */

import { writeFile } from 'node:fs/promises';
import { loadIfcFile, createHeadlessContext } from '../loader.js';
import { getFlag, getAllFlags, hasFlag, fatal, printJson } from '../output.js';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { extractPropertiesOnDemand } from '@ifc-lite/parser';
import { PropertyValueType } from '@ifc-lite/data';

/**
 * Parse a --where filter string.
 */
export function parseWhereFilter(filter: string): { psetName: string; propName: string; operator: string; value?: string } {
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
 * Parse a --set value. Supports two forms:
 *   "PsetName.PropName=Value"  → property set mutation
 *   "AttributeName=Value"      → entity attribute mutation (Name, Description, etc.)
 */
export function parseSetArg(setStr: string): { psetName: string | null; propName: string; value: string; isAttribute: boolean } {
  const dotIdx = setStr.indexOf('.');
  const eqIdx = setStr.indexOf('=');

  if (eqIdx <= 0) {
    fatal(`Invalid --set syntax: "${setStr}". Expected: PsetName.PropName=Value or AttributeName=Value`);
  }

  // No dot or dot comes after '=' → attribute mutation (e.g. "Name=TestWall")
  if (dotIdx <= 0 || dotIdx > eqIdx) {
    const propName = setStr.slice(0, eqIdx);
    const value = setStr.slice(eqIdx + 1);
    return { psetName: null, propName, value, isAttribute: true };
  }

  // Standard pset.prop=value form
  const psetName = setStr.slice(0, dotIdx);
  const rest = setStr.slice(dotIdx + 1);
  const restEqIdx = rest.indexOf('=');
  if (restEqIdx <= 0) {
    fatal(`Invalid --set syntax: "${setStr}". Expected: PsetName.PropName=Value`);
  }
  const propName = rest.slice(0, restEqIdx);
  const value = rest.slice(restEqIdx + 1);
  return { psetName, propName, value, isAttribute: false };
}

/**
 * Coerce string value to appropriate type and determine PropertyValueType.
 */
export function coerceValue(value: string): { coerced: string | number | boolean; valueType: PropertyValueType } {
  if (value === 'true') return { coerced: true, valueType: PropertyValueType.Boolean };
  if (value === 'false') return { coerced: false, valueType: PropertyValueType.Boolean };
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') {
    return {
      coerced: num,
      valueType: Number.isInteger(num) ? PropertyValueType.Integer : PropertyValueType.Real,
    };
  }
  return { coerced: value, valueType: PropertyValueType.String };
}

/**
 * Check if a value matches a filter operator and comparison value.
 */
export function matchesFilter(actual: any, operator: string, expected?: string): boolean {
  if (operator === 'exists') return actual != null;
  if (actual == null || expected == null) return false;
  const numActual = Number(actual);
  const numExpected = Number(expected);
  const isNumeric = !isNaN(numActual) && !isNaN(numExpected);
  switch (operator) {
    case '=': return isNumeric ? numActual === numExpected : String(actual) === expected;
    case '!=': return isNumeric ? numActual !== numExpected : String(actual) !== expected;
    case '>': return isNumeric ? numActual > numExpected : false;
    case '<': return isNumeric ? numActual < numExpected : false;
    case '>=': return isNumeric ? numActual >= numExpected : false;
    case '<=': return isNumeric ? numActual <= numExpected : false;
    case 'contains': return String(actual).toLowerCase().includes(expected.toLowerCase());
    default: return false;
  }
}

export async function mutateCommand(args: string[]): Promise<void> {
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) fatal('Usage: ifc-lite mutate <file.ifc> --id <N> --set PsetName.PropName=Value --out output.ifc');

  const idStr = getFlag(args, '--id');
  const type = getFlag(args, '--type');
  const setStrs = getAllFlags(args, '--set');
  const outPath = getFlag(args, '--out');
  const propFilter = getFlag(args, '--where');
  const jsonOutput = hasFlag(args, '--json');

  if (setStrs.length === 0) fatal('--set is required. Example: --set Pset_WallCommon.IsExternal=true or --set Name=TestWall');
  if (!outPath) fatal('--out is required. Specify output file path.');

  const mutations = setStrs.map(s => {
    const parsed = parseSetArg(s);
    const { coerced, valueType } = coerceValue(parsed.value);
    return { ...parsed, coerced, valueType };
  });

  // Load the store and create a BimContext for querying
  const { bim, store } = await createHeadlessContext(filePath);

  // Find target entities
  let targets: any[] = [];

  if (idStr) {
    const expressId = parseInt(idStr, 10);
    const entity = bim.entity({ modelId: 'default', expressId });
    if (!entity) fatal(`Entity #${expressId} not found`);
    targets = [entity];
  } else if (type) {
    // Auto-prefix Ifc if user omits it (e.g., "Wall" → "IfcWall")
    const normalizedTypes = type.split(',').map(t => {
      const trimmed = t.trim();
      if (trimmed.startsWith('Ifc') || trimmed.startsWith('IFC') || trimmed.startsWith('ifc')) return trimmed;
      const prefixed = 'Ifc' + trimmed;
      process.stderr.write(`Note: Auto-corrected type "${trimmed}" → "${prefixed}"\n`);
      return prefixed;
    });
    let q = bim.query().byType(...normalizedTypes);
    if (propFilter) {
      const parsed = parseWhereFilter(propFilter);
      // Try standard property where first
      const filtered = q.toArray().filter((e: any) => {
        // Check property sets
        const psets = bim.properties(e.ref);
        for (const pset of psets) {
          if (pset.name === parsed.psetName) {
            const prop = pset.properties?.find((p: any) => p.name === parsed.propName);
            if (prop && matchesFilter(prop.value, parsed.operator, parsed.value)) return true;
          }
        }
        // Fallback: check quantity sets (Qto_* aware)
        const qsets = bim.quantities(e.ref);
        for (const qset of qsets) {
          if (qset.name === parsed.psetName) {
            const qty = qset.quantities?.find((q: any) => q.name === parsed.propName);
            if (qty && matchesFilter(qty.value, parsed.operator, parsed.value)) return true;
          }
        }
        return false;
      });
      targets = filtered;
    } else {
      targets = q.toArray();
    }
  } else {
    fatal('Either --id or --type is required to select target entities.');
  }

  if (targets.length === 0) {
    fatal('No entities matched the given criteria.');
  }

  // Create MutablePropertyView with on-demand extraction from the store
  const mutationView = new MutablePropertyView(null, 'default');
  mutationView.setOnDemandExtractor((entityId: number) => {
    return extractPropertiesOnDemand(store, entityId);
  });

  // Apply mutations via the real mutation system
  let mutatedCount = 0;
  const attributeMutations: { entity: any; propName: string; value: string }[] = [];

  for (const entity of targets) {
    for (const mut of mutations) {
      if (mut.isAttribute) {
        // Attribute mutations are handled via store manipulation
        attributeMutations.push({ entity, propName: mut.propName, value: mut.value });
      } else {
        mutationView.setProperty(
          entity.ref.expressId,
          mut.psetName!,
          mut.propName,
          mut.coerced,
          mut.valueType,
        );
      }
    }
    mutatedCount++;
  }

  // Export with mutations applied via StepExporter
  const schema = store.schemaVersion ?? 'IFC4';
  const exporter = new StepExporter(store, mutationView);
  const result = exporter.export({
    schema: schema as 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5',
    applyMutations: true,
  });

  // Apply attribute mutations via STEP text post-processing
  if (attributeMutations.length > 0) {
    const textContent = new TextDecoder().decode(result.content);
    const outputContent = applyAttributeMutations(textContent, attributeMutations);
    await writeFile(outPath, outputContent, 'utf-8');
  } else {
    await writeFile(outPath, result.content);
  }

  const mutationDescs = mutations.map(m =>
    m.isAttribute ? m.propName : `${m.psetName}.${m.propName}`
  );
  if (jsonOutput) {
    printJson({
      mutated: mutatedCount,
      properties: mutationDescs.map((desc, i) => ({
        property: desc,
        value: mutations[i].coerced,
      })),
      output: outPath,
      stats: result.stats,
    });
  } else {
    for (const mut of mutations) {
      const desc = mut.isAttribute ? mut.propName : `${mut.psetName}.${mut.propName}`;
      process.stderr.write(`Mutated ${mutatedCount} entities: ${desc} = ${mut.value}\n`);
    }
    process.stderr.write(`Written to ${outPath} (${result.stats.entityCount} entities, ${result.stats.newEntityCount} new)\n`);
  }
}

/**
 * IFC entity attribute indices (0-based positions in STEP argument list).
 * Standard for all IfcRoot subtypes: GlobalId(0), OwnerHistory(1), Name(2), Description(3).
 * IfcObject subtypes add ObjectType(4). Tag varies by entity type.
 */
const ATTRIBUTE_INDEX: Record<string, number> = {
  name: 2,
  description: 3,
  objecttype: 4,
};

/**
 * IFC types that have an ObjectType attribute at index 4.
 * Only IfcObject subtypes (building elements, spatial elements) define ObjectType.
 * Relationship types (IfcRelAggregates, etc.) and type objects do NOT.
 */
const OBJECTTYPE_TYPES = new Set([
  'IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM',
  'IFCDOOR', 'IFCWINDOW', 'IFCROOF', 'IFCSTAIR', 'IFCRAILING', 'IFCMEMBER',
  'IFCPLATE', 'IFCCOVERING', 'IFCFOOTING', 'IFCPILE', 'IFCCURTAINWALL',
  'IFCRAMP', 'IFCSPACE', 'IFCBUILDINGELEMENTPROXY', 'IFCFURNISHINGELEMENT',
  'IFCFLOWSEGMENT', 'IFCFLOWTERMINAL', 'IFCFLOWFITTING', 'IFCDISTRIBUTIONELEMENT',
  'IFCOPENINGELEMENT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCPROJECT',
]);

/**
 * Apply attribute mutations to STEP content via text replacement.
 * For each target entity, finds its STEP line and replaces the attribute at the known index.
 */
function applyAttributeMutations(
  content: string,
  mutations: { entity: any; propName: string; value: string }[],
): string {
  // Group mutations by expressId for efficient single-pass replacement
  const mutationsByEntity = new Map<number, { propName: string; value: string }[]>();
  for (const m of mutations) {
    const id = m.entity.ref.expressId;
    const list = mutationsByEntity.get(id) ?? [];
    list.push({ propName: m.propName, value: m.value });
    mutationsByEntity.set(id, list);
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match entity lines: #123=IFCTYPE(...);
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\s*\(/);
    if (!match) continue;

    const expressId = parseInt(match[1], 10);
    const entityType = match[2].toUpperCase();
    const entityMuts = mutationsByEntity.get(expressId);
    if (!entityMuts) continue;

    // Parse the STEP argument list (handle nested parens and quoted strings)
    const argsStart = line.indexOf('(');
    const argsEnd = line.lastIndexOf(')');
    if (argsStart === -1 || argsEnd === -1) continue;

    const args = splitStepArgs(line.slice(argsStart + 1, argsEnd));

    for (const mut of entityMuts) {
      const attrIdx = ATTRIBUTE_INDEX[mut.propName.toLowerCase()];
      if (attrIdx !== undefined && attrIdx < args.length) {
        // Validate ObjectType is only written to entities that define it
        if (mut.propName.toLowerCase() === 'objecttype' && !OBJECTTYPE_TYPES.has(entityType)) {
          process.stderr.write(`Warning: attribute "ObjectType" not applicable to ${entityType} #${expressId}, skipping\n`);
          continue;
        }
        // Escape for STEP format and wrap in quotes
        const escaped = mut.value.replace(/\\/g, '\\\\').replace(/'/g, "''");
        args[attrIdx] = `'${escaped}'`;
      } else {
        process.stderr.write(`Warning: attribute "${mut.propName}" not recognized for entity #${expressId}\n`);
      }
    }

    lines[i] = line.slice(0, argsStart + 1) + args.join(',') + line.slice(argsEnd);
  }

  return lines.join('\n');
}

/**
 * Split a STEP argument string by commas, respecting nested parens and quoted strings.
 */
export function splitStepArgs(argsStr: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inString) {
      current += ch;
      if (ch === "'" && argsStr[i + 1] === "'") {
        current += "'";
        i++; // skip escaped quote
      } else if (ch === "'") {
        inString = false;
      }
    } else if (ch === "'") {
      inString = true;
      current += ch;
    } else if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) result.push(current);
  return result;
}
