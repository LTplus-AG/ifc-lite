/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether a hole in a ground slab's profile is roofed by the slabs above it
 * (interior: a shaft, a stair opening, a floor area under the building) or
 * open to the sky (a courtyard). Decided over the hole's whole area.
 */

import { ringContainsRing, ringsOverlap } from '../geom.js';
import type { MapPoint } from '../types.js';
import type { FootprintInput } from './footprint.js';
import { completeness, extrusionRegions, readSlabOutline, toWorld } from './outline.js';
import { asEnum } from './reader.js';

/**
 * Something above a ground slab that may roof a hole, in map coordinates: a
 * point is under it inside every polygon of one of its `regions` and outside
 * its `holes`. `certain` only when it was read in full (a slab's complete
 * outline with no unread voids; a roofing element whose every body leaf is a
 * plain extrusion).
 */
export interface UpperSlab {
  id: number;
  z: number;
  certain: boolean;
  regions: MapPoint[][][];
  holes: MapPoint[][];
}

/** Roofing that is not a slab: roofs, roofing coverings, windows (a skylight lying flat), plates (a glass roof). */
const ROOFING = ['IFCROOF', 'IFCCOVERING', 'IFCWINDOW', 'IFCWINDOWSTANDARDCASE', 'IFCPLATE', 'IFCPLATESTANDARDCASE'];

/** Every slab and roofing element of the model, mapped once (the covering test asks them for each hole). */
export function upperSlabs(input: Pick<FootprintInput, 'reader' | 'placements' | 'georef'>): UpperSlab[] {
  const { reader, placements, georef } = input;
  const out: UpperSlab[] = [];
  for (const id of [...reader.idsOfType('IFCSLAB'), ...reader.idsOfType('IFCSLABSTANDARDCASE'), ...reader.idsOfType('IFCSLABELEMENTEDCASE')]) {
    const frame = placements.ofProduct(id);
    if (!frame) continue;
    const o = readSlabOutline(reader, id);
    const map = (pts: [number, number, number][]) => toWorld(frame, pts).map((p) => ({ x: georef.toMap(p)[0], y: georef.toMap(p)[1] }));
    out.push({ id, z: georef.toMap(frame.origin)[2], certain: !o.voids && completeness(o) === 'complete', regions: o.rings.map((r) => [map(r)]), holes: o.holes.map(map) });
  }
  for (const type of ROOFING) {
    for (const id of reader.idsOfType(type)) {
      const e = reader.entity(id);
      // A covering roofs only as roofing (a ceiling or a floor finish is no roof).
      if (!e || (type === 'IFCCOVERING' && asEnum(reader.attr(e, 'PredefinedType')) !== 'ROOFING')) continue;
      const frame = placements.ofProduct(id);
      if (!frame) continue;
      const body = extrusionRegions(reader, id);
      if (body.regions.length === 0) continue;
      const map = (pts: [number, number, number][]) => toWorld(frame, pts).map((p) => georef.toMap(p));
      const regions = body.regions.map((region) => region.map(map));
      const z = Math.min(...regions.flat(2).map((p) => p[2]));
      out.push({ id, z, certain: body.complete, regions: regions.map((region) => region.map((poly) => poly.map(([x, y]) => ({ x, y })))), holes: [] });
    }
  }
  return out;
}

/**
 * A roof must contain the whole hole in one of its regions, with no crossing
 * or touching boundary and no overlap with a stated roof hole.
 * Proven, because an interior hole stays filled and an element next to it may
 * then be excluded as interior; on doubt the hole is a courtyard.
 */
export function roofedBy(above: readonly UpperSlab[], ring: MapPoint[], z: number): number[] | null {
  const roof = above.find((s) => s.certain && s.z > z + 1 && s.regions.some((region) =>
    region.every((poly) => ringContainsRing(ring, poly)) && !s.holes.some((h) => ringsOverlap(ring, h))));
  return roof ? [roof.id] : null;
}
