/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite ask <file.ifc> "<question>"
 *
 * Natural language recipe engine for BIM queries.
 * Maps common questions to SDK operations via pattern matching.
 *
 * Examples:
 *   ifc-lite ask model.ifc "how many walls?"
 *   ifc-lite ask model.ifc "what is the window-wall ratio?"
 *   ifc-lite ask model.ifc "total floor area"
 *   ifc-lite ask model.ifc "list materials" --json
 *   ifc-lite ask model.ifc "tallest storey" --explain
 */

import { createHeadlessContext } from '../loader.js';
import { printJson, fatal, hasFlag } from '../output.js';

interface Recipe {
  name: string;
  patterns: RegExp[];
  description: string;
  execute: (bim: any, store: any, match?: RegExpMatchArray) => any;
}

const RECIPES: Recipe[] = [
  // --- Counting recipes ---
  {
    name: 'count-walls',
    patterns: [/how many walls/i, /wall count/i, /number of walls/i, /count.*walls/i],
    description: 'Count all IfcWall entities',
    execute: (bim) => {
      const count = bim.query().byType('IfcWall').count();
      return { answer: `${count} walls`, count, type: 'IfcWall' };
    },
  },
  {
    name: 'count-doors',
    patterns: [/how many doors/i, /door count/i, /number of doors/i, /count.*doors/i],
    description: 'Count all IfcDoor entities',
    execute: (bim) => {
      const count = bim.query().byType('IfcDoor').count();
      return { answer: `${count} doors`, count, type: 'IfcDoor' };
    },
  },
  {
    name: 'count-windows',
    patterns: [/how many windows/i, /window count/i, /number of windows/i, /count.*windows/i],
    description: 'Count all IfcWindow entities',
    execute: (bim) => {
      const count = bim.query().byType('IfcWindow').count();
      return { answer: `${count} windows`, count, type: 'IfcWindow' };
    },
  },
  {
    name: 'count-columns',
    patterns: [/how many columns/i, /column count/i, /number of columns/i, /count.*columns/i],
    description: 'Count all IfcColumn entities',
    execute: (bim) => {
      const count = bim.query().byType('IfcColumn').count();
      return { answer: `${count} columns`, count, type: 'IfcColumn' };
    },
  },
  {
    name: 'count-slabs',
    patterns: [/how many slabs/i, /slab count/i, /number of slabs/i, /count.*slabs/i, /how many floors/i],
    description: 'Count all IfcSlab entities',
    execute: (bim) => {
      const count = bim.query().byType('IfcSlab').count();
      return { answer: `${count} slabs`, count, type: 'IfcSlab' };
    },
  },
  {
    name: 'count-all',
    patterns: [/how many elements/i, /total elements/i, /element count/i, /how many entities/i, /total entities/i],
    description: 'Count all building elements',
    execute: (bim) => {
      const count = bim.query().count();
      return { answer: `${count} total entities`, count };
    },
  },
  {
    name: 'count-type',
    patterns: [/how many (ifc\w+)/i, /count (ifc\w+)/i, /how many (\w+)/i, /count (\w+)/i, /number of (\w+)/i],
    description: 'Count entities of a specific IFC type',
    execute: (bim, _store, match) => {
      let typeName = match?.[1] ?? 'IfcProduct';
      // Auto-prefix Ifc if not already present
      if (!typeName.startsWith('Ifc') && !typeName.startsWith('IFC')) {
        // Singularize common plural forms and capitalize
        let singular = typeName;
        if (singular.endsWith('ies')) singular = singular.slice(0, -3) + 'y';
        else if (singular.endsWith('s') && !singular.endsWith('ss')) singular = singular.slice(0, -1);
        typeName = 'Ifc' + singular.charAt(0).toUpperCase() + singular.slice(1).toLowerCase();
      }
      const count = bim.query().byType(typeName).count();
      return { answer: `${count} ${typeName} entities`, count, type: typeName };
    },
  },

  // --- Area & quantity recipes ---
  {
    name: 'total-wall-area',
    patterns: [/total wall area/i, /wall area/i, /area of walls/i, /gross wall area/i],
    description: 'Sum GrossSideArea for all walls',
    execute: (bim) => {
      const walls = bim.query().byType('IfcWall').toArray();
      let total = 0;
      for (const w of walls) {
        total += getQuantity(bim, w.ref, ['GrossSideArea', 'NetSideArea']);
      }
      return { answer: `${round(total)} m2 total wall area`, value: round(total), unit: 'm2' };
    },
  },
  {
    name: 'total-floor-area',
    patterns: [/total floor area/i, /floor area/i, /slab area/i, /gross floor area/i, /gfa/i],
    description: 'Sum GrossArea for all slabs',
    execute: (bim) => {
      const slabs = bim.query().byType('IfcSlab').toArray();
      let total = 0;
      for (const s of slabs) {
        total += getQuantity(bim, s.ref, ['GrossArea', 'NetArea']);
      }
      return { answer: `${round(total)} m2 total floor area`, value: round(total), unit: 'm2' };
    },
  },
  {
    name: 'window-wall-ratio',
    patterns: [/window.?wall.?ratio/i, /wwr/i, /glazing ratio/i],
    description: 'Calculate window-to-wall ratio (ISO 13790: exterior walls only)',
    execute: (bim) => {
      const windows = bim.query().byType('IfcWindow').toArray();
      let windowArea = 0;
      for (const w of windows) windowArea += getQuantity(bim, w.ref, ['Area']);

      // Per ISO 13790, WWR should use exterior wall area only
      const { exteriorWalls, area: extWallArea, hasIsExternalData } = getExteriorWalls(bim);
      let wallArea: number;
      let wallSource: string;
      if (hasIsExternalData) {
        // Use exterior wall area (may be 0 if no walls are marked external)
        wallArea = extWallArea;
        wallSource = `${exteriorWalls.length} exterior walls`;
      } else {
        // Fallback to all walls only when IsExternal data is truly missing
        const allWalls = bim.query().byType('IfcWall').toArray();
        wallArea = 0;
        for (const w of allWalls) wallArea += getQuantity(bim, w.ref, ['GrossSideArea', 'NetSideArea']);
        wallSource = `${allWalls.length} walls (all, IsExternal not available)`;
      }

      const ratio = wallArea > 0 ? (windowArea / wallArea) * 100 : 0;
      return {
        answer: `Window-Wall Ratio: ${round(ratio)}% (${round(windowArea)} m2 windows / ${round(wallArea)} m2 ${wallSource})`,
        ratio: round(ratio),
        windowArea: round(windowArea),
        wallArea: round(wallArea),
        wallSource,
      };
    },
  },
  {
    name: 'total-volume',
    patterns: [/total volume/i, /building volume/i, /volume of/i],
    description: 'Sum volumes across all elements',
    execute: (bim) => {
      let total = 0;
      for (const e of bim.query().toArray()) {
        total += getQuantity(bim, e.ref, ['GrossVolume', 'NetVolume']);
      }
      return { answer: `${round(total)} m3 total volume`, value: round(total), unit: 'm3' };
    },
  },

  // --- Listing recipes ---
  {
    name: 'list-storeys',
    patterns: [/list.*storey/i, /what.*storey/i, /which.*storey/i, /show.*storey/i, /list.*floor/i, /what.*floor/i, /how many storey/i, /how many floor/i],
    description: 'List all building storeys',
    execute: (bim) => {
      const storeys = bim.storeys();
      const names = storeys.map((s: any) => s.name).filter(Boolean);
      return {
        answer: `${storeys.length} storeys: ${names.join(', ') || '(unnamed)'}`,
        count: storeys.length,
        storeys: names,
      };
    },
  },
  {
    name: 'list-materials',
    patterns: [/list.*material/i, /what.*material/i, /which.*material/i, /show.*material/i, /material.*list/i, /material.*takeoff/i, /material.*summary/i],
    description: 'List all unique materials with element counts',
    execute: (bim) => {
      const counts = new Map<string, number>();
      for (const e of bim.query().toArray()) {
        const mat = bim.materials(e.ref);
        const name = mat?.materials?.[0] ?? mat?.name;
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const materials = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }));
      const lines = materials.map(m => `  ${m.name}: ${m.count} elements`).join('\n');
      return {
        answer: `${materials.length} materials:\n${lines}`,
        count: materials.length,
        materials,
      };
    },
  },
  {
    name: 'list-types',
    patterns: [/list.*type/i, /what.*type/i, /which.*type/i, /element.*type/i, /type.*breakdown/i, /element.*breakdown/i],
    description: 'List element types with counts',
    execute: (bim) => {
      const counts = new Map<string, number>();
      for (const e of bim.query().toArray()) {
        if (e.type) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
      }
      const types = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({ type, count }));
      const lines = types.map(t => `  ${t.type}: ${t.count}`).join('\n');
      return {
        answer: `${types.length} element types:\n${lines}`,
        count: types.length,
        types,
      };
    },
  },
  {
    name: 'building-name',
    patterns: [/building name/i, /what.*building/i, /project name/i, /model name/i],
    description: 'Get the building name',
    execute: (bim) => {
      const buildings = bim.query().byType('IfcBuilding').toArray();
      const name = buildings[0]?.name ?? '(unnamed)';
      return { answer: `Building: ${name}`, name };
    },
  },
  {
    name: 'schema-version',
    patterns: [/schema/i, /ifc version/i, /which version/i, /what version/i, /file format/i],
    description: 'Get the IFC schema version',
    execute: (_bim, store) => {
      const schema = store.schemaVersion;
      return { answer: `Schema: ${schema}`, schema };
    },
  },

  // --- Spatial recipes ---
  {
    name: 'tallest-storey',
    patterns: [/tallest.*storey/i, /highest.*storey/i, /tallest.*floor/i, /highest.*floor/i, /top.*storey/i, /top.*floor/i],
    description: 'Find the storey with the most elements',
    execute: (bim) => {
      const storeys = bim.storeys();
      let maxName = '(none)';
      let maxCount = 0;
      for (const s of storeys) {
        const contained = bim.contains(s.ref);
        if (contained.length > maxCount) {
          maxCount = contained.length;
          maxName = s.name ?? '(unnamed)';
        }
      }
      return { answer: `Largest storey: ${maxName} with ${maxCount} elements`, storey: maxName, elementCount: maxCount };
    },
  },

  // --- Validation recipes ---
  {
    name: 'duplicate-ids',
    patterns: [/duplicate.*id/i, /duplicate.*global/i, /check.*id/i, /id.*duplicate/i, /validation/i, /health.*check/i],
    description: 'Check for duplicate GlobalIds',
    execute: (bim) => {
      const entities = bim.query().toArray();
      const ids = entities.map((e: any) => e.globalId).filter(Boolean);
      const counts = new Map<string, number>();
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      const duplicates = [...counts.entries()].filter(([, c]) => c > 1);
      if (duplicates.length === 0) {
        return { answer: 'No duplicate GlobalIds found', duplicateCount: 0 };
      }
      return {
        answer: `${duplicates.length} duplicate GlobalIds found`,
        duplicateCount: duplicates.length,
        duplicates: duplicates.map(([id, count]) => ({ id, count })),
      };
    },
  },

  // --- Exterior wall recipe ---
  {
    name: 'exterior-walls',
    patterns: [/exterior.*wall/i, /external.*wall/i, /outside.*wall/i, /facade.*area/i],
    description: 'Count and measure exterior walls (IsExternal=true)',
    execute: (bim) => {
      const { exteriorWalls, area: extArea, hasIsExternalData } = getExteriorWalls(bim);
      if (!hasIsExternalData) {
        // Fallback: no IsExternal property data available
        const allWalls = bim.query().byType('IfcWall').toArray();
        let totalArea = 0;
        for (const w of allWalls) totalArea += getQuantity(bim, w.ref, ['GrossSideArea', 'NetSideArea']);
        return {
          answer: `${allWalls.length} walls (IsExternal property not available — showing all walls), ${round(totalArea)} m2 total area`,
          count: allWalls.length,
          area: round(totalArea),
          caveat: 'IsExternal property not found; results include all walls',
        };
      }
      return {
        answer: `${exteriorWalls.length} exterior walls, ${round(extArea)} m2 total area`,
        count: exteriorWalls.length,
        area: round(extArea),
      };
    },
  },

  // --- Ranking recipes ---
  {
    name: 'largest-element',
    patterns: [/largest wall/i, /biggest wall/i, /largest slab/i, /biggest slab/i, /largest (\w+)/i, /biggest (\w+)/i],
    description: 'Find the largest element by area or volume',
    execute: (bim, _store, match) => {
      const typeHint = match?.[1]?.toLowerCase() ?? 'wall';
      const typeMap: Record<string, string> = {
        wall: 'IfcWall', slab: 'IfcSlab', window: 'IfcWindow', door: 'IfcDoor',
        column: 'IfcColumn', beam: 'IfcBeam', roof: 'IfcRoof', pile: 'IfcPile',
      };
      const ifcType = typeMap[typeHint] ?? ('Ifc' + typeHint.charAt(0).toUpperCase() + typeHint.slice(1));
      const areaNames = ifcType === 'IfcWall'
        ? ['GrossSideArea', 'NetSideArea']
        : ['GrossArea', 'NetArea', 'Area', 'GrossSideArea'];

      const entities = bim.query().byType(ifcType).toArray();
      let maxEntity: any = null;
      let maxValue = 0;
      for (const e of entities) {
        const val = getQuantity(bim, e.ref, areaNames) || getQuantity(bim, e.ref, ['GrossVolume', 'NetVolume']);
        if (val > maxValue) {
          maxValue = val;
          maxEntity = e;
        }
      }
      if (!maxEntity) {
        return { answer: `No ${ifcType} entities found`, count: 0 };
      }
      return {
        answer: `Largest ${ifcType}: "${maxEntity.name ?? '(unnamed)'}" with ${round(maxValue)} (m2 or m3)`,
        name: maxEntity.name,
        globalId: maxEntity.globalId,
        value: round(maxValue),
        type: ifcType,
      };
    },
  },
  {
    name: 'smallest-element',
    patterns: [/smallest wall/i, /smallest slab/i, /smallest (\w+)/i],
    description: 'Find the smallest element by area or volume',
    execute: (bim, _store, match) => {
      const typeHint = match?.[1]?.toLowerCase() ?? 'wall';
      const typeMap: Record<string, string> = {
        wall: 'IfcWall', slab: 'IfcSlab', window: 'IfcWindow', door: 'IfcDoor',
        column: 'IfcColumn', beam: 'IfcBeam',
      };
      const ifcType = typeMap[typeHint] ?? ('Ifc' + typeHint.charAt(0).toUpperCase() + typeHint.slice(1));
      const areaNames = ifcType === 'IfcWall'
        ? ['GrossSideArea', 'NetSideArea']
        : ['GrossArea', 'NetArea', 'Area', 'GrossSideArea'];

      const entities = bim.query().byType(ifcType).toArray();
      let minEntity: any = null;
      let minValue = Infinity;
      for (const e of entities) {
        const val = getQuantity(bim, e.ref, areaNames) || getQuantity(bim, e.ref, ['GrossVolume', 'NetVolume']);
        if (val > 0 && val < minValue) {
          minValue = val;
          minEntity = e;
        }
      }
      if (!minEntity) {
        return { answer: `No ${ifcType} entities with quantities found`, count: 0 };
      }
      return {
        answer: `Smallest ${ifcType}: "${minEntity.name ?? '(unnamed)'}" with ${round(minValue)} (m2 or m3)`,
        name: minEntity.name,
        globalId: minEntity.globalId,
        value: round(minValue),
        type: ifcType,
      };
    },
  },
];

// Dynamic count-type recipe with IFC type extraction from question
function findMatchingRecipe(question: string): { recipe: Recipe; match?: RegExpMatchArray } | null {
  for (const recipe of RECIPES) {
    for (const pattern of recipe.patterns) {
      const match = question.match(pattern);
      if (match) return { recipe, match };
    }
  }
  return null;
}

export async function askCommand(args: string[]): Promise<void> {
  const jsonOutput = hasFlag(args, '--json');
  const explain = hasFlag(args, '--explain');

  // Parse positional args (skip flags)
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }

  if (positional.length < 2) {
    fatal('Usage: ifc-lite ask <file.ifc> "<question>" [--json] [--explain]\n\nExamples:\n  ifc-lite ask model.ifc "how many walls?"\n  ifc-lite ask model.ifc "window-wall ratio"\n  ifc-lite ask model.ifc "list materials" --json\n  ifc-lite ask model.ifc "total floor area" --explain\n\nUse --explain to see which recipe was matched.');
  }

  const [filePath, ...questionParts] = positional;
  const question = questionParts.join(' ');

  const found = findMatchingRecipe(question);

  if (!found) {
    if (jsonOutput) {
      printJson({ error: 'No matching recipe', question, availableRecipes: RECIPES.map(r => r.name) });
    } else {
      process.stderr.write(`No recipe matched: "${question}"\n\n`);
      process.stderr.write('Available topics:\n');
      const grouped = new Map<string, string[]>();
      for (const r of RECIPES) {
        const category = r.name.split('-')[0];
        const list = grouped.get(category) ?? [];
        list.push(`  ${r.name}: ${r.description}`);
        grouped.set(category, list);
      }
      for (const [, items] of grouped) {
        for (const item of items) {
          process.stderr.write(item + '\n');
        }
      }
      process.stderr.write('\nTip: Try phrasing your question differently, or use "ifc-lite ask <file> --explain" to debug matching.\n');
    }
    process.exit(1);
  }

  const { recipe, match } = found;
  const { bim, store } = await createHeadlessContext(filePath);

  if (explain) {
    process.stderr.write(`Recipe: ${recipe.name}\n`);
    process.stderr.write(`Description: ${recipe.description}\n`);
    process.stderr.write(`Pattern matched: ${match?.[0] ?? question}\n\n`);
  }

  try {
    const result = recipe.execute(bim, store, match);

    if (jsonOutput) {
      printJson({
        recipe: recipe.name,
        question,
        ...result,
      });
    } else {
      process.stdout.write(result.answer + '\n');
    }
  } catch (err: any) {
    if (jsonOutput) {
      printJson({ error: err.message, recipe: recipe.name, question });
      // Match the non-JSON path's verdict: a build pipeline reading only the
      // exit code must not see success on a question that could not be
      // answered (same shape as the `ids --json` always-exit-0 defect).
      process.exitCode = 1;
    } else {
      fatal(`Recipe "${recipe.name}" failed: ${err.message}`);
    }
  }
}

/**
 * Get exterior walls and their total area. Returns whether IsExternal data exists at all.
 */
function getExteriorWalls(bim: any): { exteriorWalls: any[]; area: number; hasIsExternalData: boolean } {
  const walls = bim.query().byType('IfcWall').toArray();
  const exteriorWalls: any[] = [];
  let area = 0;
  let hasIsExternalData = false;

  for (const w of walls) {
    const isExt = getPropValue(bim, w.ref, 'Pset_WallCommon', 'IsExternal');
    if (isExt !== undefined) {
      hasIsExternalData = true;
      if (isExt === true || isExt === 'TRUE' || isExt === '.T.') {
        exteriorWalls.push(w);
        area += getQuantity(bim, w.ref, ['GrossSideArea', 'NetSideArea']);
      }
    }
  }

  return { exteriorWalls, area, hasIsExternalData };
}

function getQuantity(bim: any, ref: any, names: string[]): number {
  try {
    const qsets = bim.quantities(ref);
    for (const qset of qsets) {
      for (const q of qset.quantities) {
        if (names.includes(q.name)) {
          return Number(q.value) || 0;
        }
      }
    }
  } catch {
    // No quantities available
  }
  return 0;
}

function getPropValue(bim: any, ref: any, psetName: string, propName: string): any {
  try {
    const psets = bim.properties(ref);
    for (const pset of psets) {
      if (pset.name === psetName) {
        const prop = pset.properties?.find((p: any) => p.name === propName);
        if (prop) return prop.value;
      }
    }
  } catch {
    // Property not available
  }
  return undefined;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
