/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A coarse footprint of the model in EPSG:2056, to find its own building
 * among the neighbours: the plan bounding rectangle of the model's placed
 * elements, carried to the map through the model's IfcMapConversion
 * (rotation and scale applied). The element boxes are LOD0's from
 * `@ifc-lite/export` (no meshing): an element's `IfcBoundingBox` where the
 * file has one, else a 0.2 m box at its placement, so for most files this is
 * the extent of the element placements. Walls are placed at one end, so the
 * rectangle can fall short of the true outline by up to a wall length; the
 * overlap rule (half of the smaller area) tolerates that.
 * The site context itself never uses the model's rotation; only this
 * matching footprint does, because it describes where the model stands.
 */

import { generateLod0 } from '@ifc-lite/export';
import type { ModelCentre } from './site-context-model.js';

export interface ModelFootprint {
  /** One ring, counter-clockwise, EPSG:2056 metres. */
  ring: Array<{ x: number; y: number }>;
  elements: number;
  /** Elements bounded by an `IfcBoundingBox`; the rest by their placement point. */
  shapedElements: number;
  /** Map-conversion scale applied, metres of map per metre of model. */
  scale: number;
  warnings: string[];
}

/** Elements that are not the building: the site and its terrain, annotations, grids, virtual and external-space elements. */
const NOT_BUILDING = new Set(['IfcSite', 'IfcGeographicElement', 'IfcAnnotation', 'IfcGrid', 'IfcVirtualElement', 'IfcExternalSpatialElement', 'IfcCivilElement', 'IfcProject']);

/**
 * `null` when no element is placed, or a corner cannot be converted to EPSG:2056 (said in `model.warnings`). `lengthUnitScale` is the project's length
 * unit in metres; the LOD0 boxes are in metres already.
 */
export async function modelFootprint(bytes: Uint8Array, model: ModelCentre, lengthUnitScale: number): Promise<ModelFootprint | null> {
  const lod0 = await generateLod0(bytes);
  const placed = lod0.elements.filter((e) => !NOT_BUILDING.has(e.ifcClass));
  if (placed.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of placed) {
    minX = Math.min(minX, e.bbox.min[0]);
    minY = Math.min(minY, e.bbox.min[1]);
    maxX = Math.max(maxX, e.bbox.max[0]);
    maxY = Math.max(maxY, e.bbox.max[1]);
  }
  const warnings: string[] = [];
  // IFC: Scale converts project length units to map units; the boxes are metres, the result is metres.
  let scale = (model.conversionScale ?? 1) * (model.mapUnitToMetres / lengthUnitScale);
  if (!(Math.abs(scale - 1) <= 0.1)) {
    warnings.push(`the map conversion's effective scale is ${scale}, which looks like a unit mix-up; the subject footprint uses 1`);
    scale = 1;
  }
  const theta = ((model.rotationDegrees ?? 0) * Math.PI) / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const corners: Array<[number, number]> = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
  // Rotation and scale are in the model's own map axes: place each corner in its CRS, then
  // carry that point to EPSG:2056. Adding the offsets to the reprojected origin would skip the
  // grid convergence and scale between, say, UTM and LV95 (#10480 review).
  const ring: Array<{ x: number; y: number }> = [];
  for (const [x, y] of corners) {
    const q = model.toLv95(model.sourceOrigin.x + scale * (x * cos - y * sin), model.sourceOrigin.y + scale * (x * sin + y * cos));
    if (!q) {
      model.warnings.push('a footprint corner could not be converted to EPSG:2056');
      return null;
    }
    ring.push(q);
  }
  if (maxX - minX < 1 || maxY - minY < 1) warnings.push(`the model's element placements span only ${(maxX - minX).toFixed(2)} × ${(maxY - minY).toFixed(2)} m, too little to find its building by`);
  return { ring, elements: placed.length, shapedElements: placed.filter((e) => e.bbox_source === 'shape').length, scale, warnings };
}
