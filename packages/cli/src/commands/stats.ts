/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite stats <file.ifc>
 *
 * Auto-calculated model KPIs and health check.
 * Provides a one-command overview of building metrics.
 */

import { createHeadlessContext } from '../loader.js';
import { printJson, hasFlag, fatal } from '../output.js';

export async function statsCommand(args: string[]): Promise<void> {
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) fatal('Usage: ifc-lite stats <file.ifc> [--json]');

  const jsonOutput = hasFlag(args, '--json');
  const { bim, store } = await createHeadlessContext(filePath);

  // Basic model info
  const schema = store.schemaVersion;
  const entityCount = store.entityCount;

  // Storeys
  const storeys = bim.storeys();
  const storeyNames = storeys.map((s: any) => s.name).filter(Boolean);

  // Building name
  const buildings = bim.query().byType('IfcBuilding').toArray();
  const buildingName = buildings[0]?.name ?? '(unnamed)';

  // Element counts by type
  const ELEMENT_TYPES = [
    'IfcWall', 'IfcSlab', 'IfcDoor', 'IfcWindow', 'IfcColumn', 'IfcBeam',
    'IfcRoof', 'IfcStair', 'IfcRailing', 'IfcSpace', 'IfcMember', 'IfcPlate',
    'IfcCovering', 'IfcFooting', 'IfcPile', 'IfcCurtainWall', 'IfcFurnishingElement',
    'IfcRamp',
  ];
  const elementCounts: Record<string, number> = {};
  let totalElements = 0;
  for (const t of ELEMENT_TYPES) {
    const count = bim.query().byType(t).count();
    if (count > 0) {
      elementCounts[t] = count;
      totalElements += count;
    }
  }

  // Quantity aggregations
  const walls = bim.query().byType('IfcWall').toArray();
  const slabs = bim.query().byType('IfcSlab').toArray();
  const windows = bim.query().byType('IfcWindow').toArray();

  let totalWallArea = 0;
  let exteriorWallArea = 0;
  let totalWallVolume = 0;
  for (const w of walls) {
    let wallArea = 0;
    let wallVolume = 0;
    const qsets = bim.quantities(w.ref);
    for (const qset of qsets) {
      for (const q of qset.quantities) {
        if (q.name === 'GrossSideArea' || q.name === 'NetSideArea') {
          wallArea = Number(q.value) || 0;
        }
        if (q.name === 'GrossVolume' || q.name === 'NetVolume') {
          wallVolume = Number(q.value) || 0;
        }
      }
    }
    totalWallArea += wallArea;
    totalWallVolume += wallVolume;

    // Check IsExternal from Pset_WallCommon
    const isExternal = getPropertyValue(bim, w.ref, 'Pset_WallCommon', 'IsExternal');
    if (isExternal === true || isExternal === 'TRUE' || isExternal === '.T.') {
      exteriorWallArea += wallArea;
    }
  }

  let totalFloorArea = 0;
  let totalSlabVolume = 0;
  for (const s of slabs) {
    const qsets = bim.quantities(s.ref);
    for (const qset of qsets) {
      for (const q of qset.quantities) {
        if (q.name === 'GrossArea' || q.name === 'NetArea') {
          totalFloorArea += Number(q.value) || 0;
        }
        if (q.name === 'GrossVolume' || q.name === 'NetVolume') {
          totalSlabVolume += Number(q.value) || 0;
        }
      }
    }
  }

  let totalWindowArea = 0;
  for (const w of windows) {
    const qsets = bim.quantities(w.ref);
    for (const qset of qsets) {
      for (const q of qset.quantities) {
        if (q.name === 'Area') {
          totalWindowArea += Number(q.value) || 0;
          break;
        }
      }
    }
  }

  // WWR uses exterior wall area if available, falls back to total wall area
  const wwrBase = exteriorWallArea > 0 ? exteriorWallArea : totalWallArea;
  const windowWallRatio = wwrBase > 0 ? (totalWindowArea / wwrBase) * 100 : 0;

  // GFA: sum GrossFloorArea from IfcBuildingStorey quantities, fallback to slab area
  let grossFloorArea = 0;
  for (const storey of storeys) {
    const qsets = bim.quantities(storey.ref);
    for (const qset of qsets) {
      for (const q of qset.quantities) {
        if (q.name === 'GrossFloorArea') {
          grossFloorArea += Number(q.value) || 0;
        }
      }
    }
  }
  if (grossFloorArea === 0) grossFloorArea = totalFloorArea;

  // Total volume across all elements
  let totalVolume = totalWallVolume + totalSlabVolume;
  const volTypes = ['IfcColumn', 'IfcBeam', 'IfcRoof', 'IfcStair', 'IfcFooting'];
  for (const t of volTypes) {
    for (const e of bim.query().byType(t).toArray()) {
      const qsets = bim.quantities(e.ref);
      for (const qset of qsets) {
        for (const q of qset.quantities) {
          if (q.name === 'GrossVolume' || q.name === 'NetVolume') {
            totalVolume += Number(q.value) || 0;
          }
        }
      }
    }
  }

  // Material summary with volumes
  const materialVolumes = new Map<string, number>();
  const materialCounts = new Map<string, number>();
  const allBuildingElements = bim.query().toArray();
  for (const e of allBuildingElements) {
    const mat = bim.materials(e.ref);
    const first = mat?.materials?.[0];
    const firstName = typeof first === 'string' ? first : first?.name;
    const matName = firstName ?? mat?.name;
    if (!matName) continue;

    materialCounts.set(matName, (materialCounts.get(matName) ?? 0) + 1);

    const qsets = bim.quantities(e.ref);
    for (const qset of qsets) {
      for (const q of qset.quantities) {
        if (q.name === 'GrossVolume' || q.name === 'NetVolume') {
          materialVolumes.set(matName, (materialVolumes.get(matName) ?? 0) + (Number(q.value) || 0));
          break;
        }
      }
    }
  }

  const materialSummary = [...materialCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({
      name,
      count,
      volume: round(materialVolumes.get(name) ?? 0),
    }));

  // Validation checks
  const globalIds = allBuildingElements.map((e: any) => e.globalId).filter(Boolean);
  const globalIdCounts = new Map<string, number>();
  for (const id of globalIds) {
    globalIdCounts.set(id, (globalIdCounts.get(id) ?? 0) + 1);
  }
  const duplicateGlobalIds = [...globalIdCounts.entries()].filter(([, count]) => count > 1).length;
  const unnamedElements = allBuildingElements.filter((e: any) => !e.name || e.name === '').length;

  const stats = {
    building: buildingName,
    schema,
    entityCount,
    storeys: storeyNames,
    storeyCount: storeys.length,
    elements: elementCounts,
    totalElements,
    quantities: {
      totalWallArea: round(totalWallArea),
      exteriorWallArea: round(exteriorWallArea),
      totalFloorArea: round(totalFloorArea),
      grossFloorArea: round(grossFloorArea),
      totalWindowArea: round(totalWindowArea),
      windowWallRatio: round(windowWallRatio),
      totalVolume: round(totalVolume),
    },
    materials: materialSummary,
    validation: {
      duplicateGlobalIds,
      unnamedElements,
    },
  };

  if (jsonOutput) {
    printJson(stats);
    return;
  }

  process.stdout.write(`\n  Building: ${buildingName}\n`);
  process.stdout.write(`  Schema: ${schema} | Storeys: ${storeys.length} | Elements: ${totalElements}\n`);
  if (storeyNames.length > 0) {
    process.stdout.write(`  Storeys: ${storeyNames.join(', ')}\n`);
  }
  process.stdout.write('\n');

  // Element breakdown
  process.stdout.write('  Element breakdown:\n');
  const sortedElements = Object.entries(elementCounts).sort((a, b) => b[1] - a[1]);
  for (const [typeName, count] of sortedElements) {
    process.stdout.write(`    ${typeName}: ${count}\n`);
  }
  process.stdout.write('\n');

  // Quantities
  if (totalWallArea > 0 || totalFloorArea > 0 || totalVolume > 0) {
    process.stdout.write('  Quantities:\n');
    if (totalWallArea > 0) process.stdout.write(`    Total wall area: ${round(totalWallArea)} m2\n`);
    if (exteriorWallArea > 0) process.stdout.write(`    Exterior wall area: ${round(exteriorWallArea)} m2\n`);
    if (totalFloorArea > 0) process.stdout.write(`    Total floor area: ${round(totalFloorArea)} m2\n`);
    if (grossFloorArea > 0 && grossFloorArea !== totalFloorArea) {
      process.stdout.write(`    Gross floor area (GFA): ${round(grossFloorArea)} m2\n`);
    }
    if (totalWindowArea > 0) process.stdout.write(`    Total window area: ${round(totalWindowArea)} m2\n`);
    if (windowWallRatio > 0) process.stdout.write(`    Window-Wall Ratio: ${round(windowWallRatio)}%\n`);
    if (totalVolume > 0) process.stdout.write(`    Total volume: ${round(totalVolume)} m3\n`);
    process.stdout.write('\n');
  }

  // Materials
  if (materialSummary.length > 0) {
    process.stdout.write('  Materials:\n');
    for (const m of materialSummary) {
      const volStr = m.volume > 0 ? ` (${m.volume} m3)` : '';
      process.stdout.write(`    ${m.name}: ${m.count} elements${volStr}\n`);
    }
    process.stdout.write('\n');
  }

  // Validation
  process.stdout.write('  Validation:\n');
  if (duplicateGlobalIds > 0) {
    process.stdout.write(`    ! ${duplicateGlobalIds} duplicate GlobalIds\n`);
  } else {
    process.stdout.write(`    ok All GlobalIds unique\n`);
  }
  if (unnamedElements > 0) {
    process.stdout.write(`    ! ${unnamedElements} unnamed elements\n`);
  } else {
    process.stdout.write(`    ok All elements named\n`);
  }
  process.stdout.write('\n');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function getPropertyValue(bim: any, ref: any, psetName: string, propName: string): any {
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
