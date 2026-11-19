/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The material layer a cut segment belongs to. One `MeshData` is one layer of
 * a layered wall or slab, carrying its colour and its `IfcMaterial` id; the
 * polygon builder groups an entity's segments by both, so two layers of the
 * same colour still reconstruct as separate polygons.
 */

import type { CutSegment, DrawingPolygon } from './types.js';
import { colorKey } from './types.js';

/** Grouping key for one layer of an entity's cut: colour together with material. */
export function layerKey(seg: CutSegment): string {
  return `${colorKey(seg.color)}|${seg.materialId ?? ''}`;
}

/** The source fields a layer's polygons carry: `sourceColor` and `materialId`, each only when set. */
export function layerStamp(seg: CutSegment): Pick<DrawingPolygon, 'sourceColor' | 'materialId'> {
  return {
    ...(seg.color ? { sourceColor: seg.color } : {}),
    ...(seg.materialId !== undefined ? { materialId: seg.materialId } : {}),
  };
}
