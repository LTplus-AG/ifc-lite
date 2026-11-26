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
import { computeModelStats } from '@ifc-lite/sdk/headless';

export async function statsCommand(args: string[]): Promise<void> {
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) fatal('Usage: ifc-lite stats <file.ifc> [--json]');

  const jsonOutput = hasFlag(args, '--json');
  const { bim, store } = await createHeadlessContext(filePath);

  const stats = computeModelStats(bim, store);
  const {
    building: buildingName, schema, storeyCount, storeys: storeyNames, elements: elementCounts, totalElements,
    quantities: { totalWallArea, exteriorWallArea, totalFloorArea, grossFloorArea, totalWindowArea, windowWallRatio, totalVolume },
    materials: materialSummary, validation: { duplicateGlobalIds, unnamedElements },
  } = stats;

  if (jsonOutput) {
    printJson(stats);
    return;
  }

  process.stdout.write(`\n  Building: ${buildingName}\n`);
  process.stdout.write(`  Schema: ${schema} | Storeys: ${storeyCount} | Elements: ${totalElements}\n`);
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
