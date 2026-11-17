/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The terrain layer: chunk and skirt features from an elevation grid, with its issues and provenance. */

import type { ElevationGrid } from '@ifc-lite/geodata-ch';
import { buildTerrainMeshes, CHUNK_CELLS, SKIRT_DEPTH } from './terrain-mesh.js';
import type { JsonValue, SiteContextIssue, SiteContextLayer } from './types.js';

/** The acquisition year of a swissALTI3D source: its `datetime`, else the year in the item id. */
function sourceYear(s: ElevationGrid['sources'][number]): number | null {
  const fromDate = s.acquired ? /^(\d{4})/.exec(s.acquired) : null;
  const fromId = /_(\d{4})_/.exec(s.id);
  const y = fromDate?.[1] ?? fromId?.[1];
  return y ? Number(y) : null;
}

export function terrainProvenance(grid: ElevationGrid): { [key: string]: JsonValue } {
  return {
    dataset: 'swissALTI3D',
    crs: grid.crs,
    verticalCrs: grid.verticalCrs,
    verticalReference: grid.verticalReference,
    resolution: grid.resolution,
    gridOrigin: [grid.origin.x, grid.origin.y],
    gridSize: [grid.width, grid.height],
    sources: grid.sources.map((s) => ({ id: s.id, url: s.url, acquired: s.acquired, year: sourceYear(s), gsd: s.gsd })),
    missingTiles: [...grid.missingTiles],
  };
}

export function terrainLayer(grid: ElevationGrid, h0: number): SiteContextLayer {
  const meshes = buildTerrainMeshes(grid, h0);
  const provenance = terrainProvenance(grid);
  const issues: SiteContextIssue[] = [];
  if (grid.missingTiles.length > 0) {
    issues.push({
      code: 'terrain-missing-tiles',
      severity: 'warning',
      message: `swissALTI3D has no tile for ${grid.missingTiles.join(', ')}; that part of the site has no terrain`,
      count: grid.missingTiles.length,
    });
  }
  if (meshes.droppedCells > 0) {
    issues.push({
      code: 'terrain-nodata-cells',
      severity: 'warning',
      message: `${meshes.droppedCells} grid cells have a corner without height data and were left out (no heights were filled in)`,
      count: meshes.droppedCells,
    });
  }
  if (meshes.skirtGaps > 0) {
    issues.push({
      code: 'terrain-skirt-gaps',
      severity: 'info',
      message: `${meshes.skirtGaps} segments of the outer edge have no skirt wall because their terrain is missing`,
      count: meshes.skirtGaps,
    });
  }
  const sourceYears = [...new Set(grid.sources.map(sourceYear))].filter((y): y is number => y !== null).sort();
  if (sourceYears.length > 1) {
    issues.push({
      code: 'terrain-mixed-years',
      severity: 'info',
      message: `the site spans tiles acquired in different years (${sourceYears.join(', ')})`,
    });
  }

  const features: SiteContextLayer['features'] = meshes.chunks.map((chunk) => ({
    id: `terrain:chunk:r${chunk.row}c${chunk.col}`,
    ifcType: 'IfcGeographicElement',
    name: `Terrain r${chunk.row} c${chunk.col}`,
    origin: chunk.origin,
    mesh: chunk.mesh,
    attributes: {
      PredefinedType: 'TERRAIN',
      part: 'surface',
      chunkRow: chunk.row,
      chunkCol: chunk.col,
      chunkCells: CHUNK_CELLS,
      resolution: grid.resolution,
    },
    provenance,
  }));
  if (meshes.skirt) {
    features.push({
      id: 'terrain:skirt',
      ifcType: 'IfcGeographicElement',
      name: 'Terrain skirt',
      origin: meshes.skirt.origin,
      mesh: meshes.skirt.mesh,
      attributes: {
        PredefinedType: 'TERRAIN',
        part: 'skirt',
        skirtBottom: meshes.minHeight - SKIRT_DEPTH,
        skirtDepthBelowMinimum: SKIRT_DEPTH,
        resolution: grid.resolution,
      },
      provenance,
    });
  }
  return {
    kind: 'terrain',
    features,
    attribution: [...grid.attribution],
    issues,
    complete: grid.missingTiles.length === 0 && grid.noDataCount === 0,
  };
}
