/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { BimContext } from '../context.js';
import {
  aggregateWalls,
  computeWindowWallRatio,
  computeGrossFloorArea,
  computeMaterialSummary,
  computeValidation,
  filterBuildingElements,
  computeStoreyNames,
  computeBuildingName,
  sumQuantity,
} from './stats-aggregation.js';

/** Compute the CLI's model KPIs over the selected headless model. */
export function computeModelStats(bim: BimContext, store: IfcDataStore, entityCount = store.entityCount) {
  // Basic model info
  const schema = store.schemaVersion;

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

  const totalFloorArea = sumQuantity(bim, slabs.map((s) => s.ref), ['GrossArea', 'NetArea']);
  const totalSlabVolume = sumQuantity(bim, slabs.map((s) => s.ref), ['GrossVolume', 'NetVolume']);

  const totalWindowArea = sumQuantity(bim, windows.map((w) => w.ref), ['Area']);

  // WWR uses exterior wall area if available, falls back to total wall area
  const windowWallRatio = computeWindowWallRatio(totalWindowArea, exteriorWallArea, totalWallArea);

  // GFA: sum GrossFloorArea from IfcBuildingStorey quantities, fallback to slab area
  const grossFloorArea = computeGrossFloorArea(bim, storeys, totalFloorArea);

  // Total volume across all elements
  let totalVolume = totalWallVolume + totalSlabVolume;
  const volTypes = ['IfcColumn', 'IfcBeam', 'IfcRoof', 'IfcStair', 'IfcFooting'];
  for (const t of volTypes) {
    const refs = bim.query().byType(t).toArray().map((e) => e.ref);
    totalVolume += sumQuantity(bim, refs, ['GrossVolume', 'NetVolume']);
  }

  // Material summary with volumes
  const allBuildingElements = filterBuildingElements(bim.query().toArray());
  const materialSummary = computeMaterialSummary(bim, allBuildingElements, round);

  // Validation checks
  const { duplicateGlobalIds, unnamedElements } = computeValidation(allBuildingElements);

  return {
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
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
