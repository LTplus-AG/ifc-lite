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
import {
  aggregateWalls,
  computeWindowWallRatio,
  computeGrossFloorArea,
  computeMaterialSummary,
  computeValidation,
  computeStoreyNames,
  computeBuildingName,
  sumQuantity,
} from './stats-aggregation.js';

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
  const storeyNames = computeStoreyNames(storeys);

  // Building name
  const buildings = bim.query().byType('IfcBuilding').toArray();
  const buildingName = computeBuildingName(buildings);

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

  const { totalWallArea, exteriorWallArea, totalWallVolume } = aggregateWalls(bim, walls);

  const totalFloorArea = sumQuantity(bim, slabs.map((s: any) => s.ref), ['GrossArea', 'NetArea']);
  const totalSlabVolume = sumQuantity(bim, slabs.map((s: any) => s.ref), ['GrossVolume', 'NetVolume']);

  const totalWindowArea = sumQuantity(bim, windows.map((w: any) => w.ref), ['Area']);

  // WWR uses exterior wall area if available, falls back to total wall area
  const windowWallRatio = computeWindowWallRatio(totalWindowArea, exteriorWallArea, totalWallArea);

  // GFA: sum GrossFloorArea from IfcBuildingStorey quantities, fallback to slab area
  const grossFloorArea = computeGrossFloorArea(bim, storeys, totalFloorArea);

  // Total volume across all elements
  let totalVolume = totalWallVolume + totalSlabVolume;
  const volTypes = ['IfcColumn', 'IfcBeam', 'IfcRoof', 'IfcStair', 'IfcFooting'];
  for (const t of volTypes) {
    const refs = bim.query().byType(t).toArray().map((e: any) => e.ref);
    totalVolume += sumQuantity(bim, refs, ['GrossVolume', 'NetVolume']);
  }

  // Material summary with volumes
  const allBuildingElements = bim.query().toArray();
  const materialSummary = computeMaterialSummary(bim, allBuildingElements, round);

  // Validation checks
  const { duplicateGlobalIds, unnamedElements } = computeValidation(allBuildingElements);

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
